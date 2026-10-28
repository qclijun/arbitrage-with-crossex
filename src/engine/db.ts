/**
 * Engine store — node:sqlite (DatabaseSync, synchronous: the single-writer loop
 * never overlaps a transaction). The SQLite file IS the system of record.
 *
 * Pragmas: WAL + synchronous=FULL (fsync per commit — power-loss safe);
 * locking_mode=EXCLUSIVE on file-backed DBs (a second process cannot open the
 * DB for write — the single-instance guard). All multi-statement writes use
 * BEGIN IMMEDIATE (write lock up front).
 */
import { DatabaseSync } from 'node:sqlite';
import { AdmissionSwitch } from './admission';
import { FundingIntents } from './funding-intents';
import { fx, fxDiv, fxMul, fxStr, FX_ZERO } from './fx';
import { claimExclusive, inSavepoint } from './ledger/sqlite';
import { prepareLedger } from './ledger/version';
import { SliceLedger } from './slices';
import type { AlertRow, LegLeverage, LegSpec, OrderRow, PairMode, PairRow } from './types';

/** FNV-1a → base36 hash: compresses a whole client uuid into 7 chars so order
 * texts fit Gate's 28-byte cap. */
function fnv1a36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

interface PairDbRow {
  id: string;
  mode: string;
  a_contract: string; a_side: string; a_lot: string; a_min_size: string; a_min_notional: string;
  a_tick: string; a_reduce_only: number;
  b_contract: string | null; b_side: string | null; b_lot: string | null;
  b_min_size: string | null; b_min_notional: string | null;
  b_tick: string | null; b_reduce_only: number;
  target_qty: string;
  limit_price: string | null;
  price_policy: string;
  auto_price_policy: string;
  deadline_at: number | null;
  maker_not_before: number;
  hedge_not_before: number;
  poc_rejects: number;
  hedge_reject_streak: number;
  reprice_count: number;
  last_maker_placement_at: number;
  post_only_rejects: number;
  book_outage_started_at: number;
  max_clip: string | null;
  clip_band_bp: number | null;
  halt_reason: string | null;
  report_json: string | null;
  created_at: number;
  purpose: string | null;
  purpose_context: string | null;
  leverage_json: string | null;
}

interface OrderDbRow {
  pair_id: string; leg: string; seq: number; client_id: string;
  kind: string; side: string; qty: string; price: string | null; tif: string;
  state: string; venue_order_id: string | null; cum_qty: string; avg_fill_price: string;
  close_reason: string | null; cancel_requested: number;
  quarantined_status: string | null; venue_reason: string | null; read_fail_streak: number;
  created_at: number; resolved_at: number | null;
}

function toPair(r: PairDbRow): PairRow {
  const a: LegSpec = {
    contract: r.a_contract,
    side: r.a_side as LegSpec['side'],
    lot: r.a_lot,
    minSize: r.a_min_size,
    minNotional: r.a_min_notional,
    tick: r.a_tick,
    ...(r.a_reduce_only ? { reduceOnly: true } : {}),
  };
  const b: LegSpec | null = r.b_contract
    ? {
        contract: r.b_contract,
        side: r.b_side as LegSpec['side'],
        lot: r.b_lot ?? '0.0001',
        minSize: r.b_min_size ?? '0',
        minNotional: r.b_min_notional ?? '0',
        tick: r.b_tick ?? '0.0001',
        ...(r.b_reduce_only ? { reduceOnly: true } : {}),
      }
    : null;
  return {
    id: r.id,
    mode: r.mode as PairMode,
    a,
    b,
    targetQty: r.target_qty,
    limitPrice: r.limit_price,
    pricePolicy: r.price_policy as PairRow['pricePolicy'],
    // `SELECT *` on a row written before the column existed yields `undefined`.
    // Falling back to `pricePolicy` would be wrong (a pinned legacy deal reads
    // 'fixed', which is not a valid family): 'touch' is the historical default,
    // and every pre-'best' deal was in fact a 'touch'-family deal.
    autoPricePolicy: (r.auto_price_policy as PairRow['autoPricePolicy']) ?? 'touch',
    deadlineAt: r.deadline_at,
    makerNotBefore: r.maker_not_before,
    hedgeNotBefore: r.hedge_not_before,
    pocRejects: r.poc_rejects,
    hedgeRejectStreak: r.hedge_reject_streak,
    // `SELECT *` on a row written before these columns existed yields
    // `undefined`. The defaults are load-bearing: `undefined + 1` is NaN and
    // `undefined >= cap` is false, which would silently disable the reprice cap.
    repriceCount: r.reprice_count ?? 0,
    lastMakerPlacementAt: r.last_maker_placement_at ?? 0,
    postOnlyRejects: r.post_only_rejects ?? 0,
    bookOutageStartedAt: r.book_outage_started_at ?? 0,
    maxClip: r.max_clip,
    clipBandBp: r.clip_band_bp,
    haltReason: r.halt_reason,
    reportJson: r.report_json,
    createdAt: r.created_at,
    purpose: r.purpose as PairRow['purpose'],
    purposeContext: r.purpose_context,
    leverage: r.leverage_json ? (JSON.parse(r.leverage_json) as LegLeverage[]) : null,
  };
}

function toOrder(r: OrderDbRow): OrderRow {
  return {
    pairId: r.pair_id,
    leg: r.leg as OrderRow['leg'],
    seq: r.seq,
    clientId: r.client_id,
    kind: r.kind as OrderRow['kind'],
    side: r.side as OrderRow['side'],
    qty: r.qty,
    price: r.price,
    tif: r.tif as OrderRow['tif'],
    state: r.state as OrderRow['state'],
    venueOrderId: r.venue_order_id,
    cumQty: r.cum_qty,
    avgFillPrice: r.avg_fill_price,
    closeReason: r.close_reason,
    cancelRequested: (r.cancel_requested ? 1 : 0) as 0 | 1,
    quarantinedStatus: r.quarantined_status,
    venueReason: r.venue_reason,
    readFailStreak: r.read_fail_streak ?? 0,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/** Patchable pair fields (a patch is one small committed transaction). */
/** One finished two-leg deal's realized fills, verbatim journal strings —
 * consumed by the strategy route, which converts to numbers and seconds. */
export interface DealFillReportRow {
  /** The pair row's id — a stable identity for one execution, so the strategy
   * view can address a single deal's contribution to the entry cost. */
  dealId: string;
  aContract: string;
  aSide: string;
  bContract: string;
  bSide: string;
  aFilled: string;
  bFilled: string;
  aAvgFill: string;
  bAvgFill: string;
  createdAtMs: number;
}

export interface PairPatch {
  mode?: PairMode;
  limitPrice?: string | null;
  pricePolicy?: PairRow['pricePolicy'];
  autoPricePolicy?: PairRow['autoPricePolicy'];
  deadlineAt?: number | null;
  makerNotBefore?: number;
  hedgeNotBefore?: number;
  pocRejects?: number;
  hedgeRejectStreak?: number;
  repriceCount?: number;
  lastMakerPlacementAt?: number;
  postOnlyRejects?: number;
  bookOutageStartedAt?: number;
  haltReason?: string | null;
  reportJson?: string | null;
}

export interface OrderPatch {
  state?: OrderRow['state'];
  venueOrderId?: string | null;
  cumQty?: string;
  avgFillPrice?: string;
  closeReason?: string | null;
  cancelRequested?: 0 | 1;
  quarantinedStatus?: string | null;
  venueReason?: string | null;
  readFailStreak?: number;
  resolvedAt?: number | null;
}

const PAIR_COLS: Record<keyof PairPatch, string> = {
  mode: 'mode',
  limitPrice: 'limit_price',
  pricePolicy: 'price_policy',
  autoPricePolicy: 'auto_price_policy',
  deadlineAt: 'deadline_at',
  makerNotBefore: 'maker_not_before',
  hedgeNotBefore: 'hedge_not_before',
  pocRejects: 'poc_rejects',
  hedgeRejectStreak: 'hedge_reject_streak',
  repriceCount: 'reprice_count',
  lastMakerPlacementAt: 'last_maker_placement_at',
  postOnlyRejects: 'post_only_rejects',
  bookOutageStartedAt: 'book_outage_started_at',
  haltReason: 'halt_reason',
  reportJson: 'report_json',
};

const ORDER_COLS: Record<keyof OrderPatch, string> = {
  state: 'state',
  venueOrderId: 'venue_order_id',
  cumQty: 'cum_qty',
  avgFillPrice: 'avg_fill_price',
  closeReason: 'close_reason',
  cancelRequested: 'cancel_requested',
  quarantinedStatus: 'quarantined_status',
  venueReason: 'venue_reason',
  readFailStreak: 'read_fail_streak',
  resolvedAt: 'resolved_at',
};

export class Store {
  private db: DatabaseSync;
  /** New funding-opportunity admission (engine/admission.ts). */
  readonly admission: AdmissionSwitch;
  /** Strategy slices and per-contract books (engine/slices.ts). */
  readonly slices: SliceLedger;
  /** Accepted funding-opportunity intents (engine/funding-intents.ts). */
  readonly fundingIntents: FundingIntents;

  /** Opens the ledger and runs the version gate and any pending migration
   * (ledger/version.ts) before anything else can read or write it. `now`
   * stamps a migration's backup and journal row; `programVersion` is this
   * release's version, which admission is bound to. */
  constructor(path: string, opts?: { now?: number; programVersion?: string | null }) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (path !== ':memory:') {
        // Single-instance guard: the first process owns the file exclusively.
        this.db.exec('PRAGMA locking_mode = EXCLUSIVE');
        // Held from here on, so nothing else writes between the version
        // check, the backup and the migration.
        claimExclusive(this.db);
      }
      prepareLedger(this.db, { file: path === ':memory:' ? null : path, now: opts?.now ?? Date.now() });
    } catch (err) {
      this.db.close(); // a refused ledger must not stay locked by this process
      throw err;
    }
    this.admission = new AdmissionSwitch(this.db, opts?.programVersion ?? null);
    this.slices = new SliceLedger(this.db, (level, pairId, message, now) => this.alert(level, pairId, message, now));
    this.fundingIntents = new FundingIntents(this.db);
  }

  /** Run several writes as one: all of them, or none (nests). */
  atomically<T>(fn: () => T): T {
    return inSavepoint(this.db, fn);
  }

  close(): void {
    this.db.close();
  }

  createPair(p: PairRow): void {
    this.db
      .prepare(
        `INSERT INTO pair (id, mode,
           a_contract, a_side, a_lot, a_min_size, a_min_notional, a_tick, a_reduce_only,
           b_contract, b_side, b_lot, b_min_size, b_min_notional, b_tick, b_reduce_only,
           target_qty, limit_price, price_policy, auto_price_policy, deadline_at,
           maker_not_before, hedge_not_before, poc_rejects, hedge_reject_streak,
           reprice_count, last_maker_placement_at, post_only_rejects, book_outage_started_at,
           max_clip, clip_band_bp, halt_reason, report_json, created_at, purpose, purpose_context, leverage_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id, p.mode,
        p.a.contract, p.a.side, p.a.lot, p.a.minSize, p.a.minNotional, p.a.tick, p.a.reduceOnly ? 1 : 0,
        p.b?.contract ?? null, p.b?.side ?? null, p.b?.lot ?? null,
        p.b?.minSize ?? null, p.b?.minNotional ?? null, p.b?.tick ?? null, p.b?.reduceOnly ? 1 : 0,
        p.targetQty, p.limitPrice, p.pricePolicy, p.autoPricePolicy, p.deadlineAt,
        p.makerNotBefore, p.hedgeNotBefore, p.pocRejects, p.hedgeRejectStreak,
        p.repriceCount, p.lastMakerPlacementAt, p.postOnlyRejects, p.bookOutageStartedAt,
        p.maxClip, p.clipBandBp, p.haltReason, p.reportJson, p.createdAt,
        p.purpose ?? null, p.purposeContext ?? null, p.leverage?.length ? JSON.stringify(p.leverage) : null,
      );
  }

  getPair(id: string): PairRow | null {
    const r = this.db.prepare('SELECT * FROM pair WHERE id = ?').get(id) as unknown as
      | PairDbRow
      | undefined;
    return r ? toPair(r) : null;
  }

  listPairs(opts?: { activeOnly?: boolean }): PairRow[] {
    const sql = opts?.activeOnly
      ? "SELECT * FROM pair WHERE mode != 'DONE' ORDER BY created_at"
      : 'SELECT * FROM pair ORDER BY created_at';
    return (this.db.prepare(sql).all() as unknown as PairDbRow[]).map(toPair);
  }

  updatePair(id: string, patch: PairPatch): void {
    const keys = Object.keys(patch) as Array<keyof PairPatch>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${PAIR_COLS[k]} = ?`).join(', ');
    this.db.prepare(`UPDATE pair SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as never), id);
  }

  /** Patch one leg of a deal's engine-owned leverage (engine/leverage.ts). */
  updateLeverage(id: string, leg: LegLeverage['leg'], patch: Partial<LegLeverage>): void {
    const legs = this.getPair(id)?.leverage;
    if (!legs) throw new Error(`deal ${id} owns no leverage`);
    const next = legs.map((l) => (l.leg === leg ? { ...l, ...patch } : l));
    this.db.prepare('UPDATE pair SET leverage_json = ? WHERE id = ?').run(JSON.stringify(next), id);
  }

  /** One initiated reprice cycle: cancel provenance and quota must survive
   * together. A retry of this order can never charge another cycle. */
  recordRepriceCancel(o: OrderRow): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const marked = this.db.prepare(
        'UPDATE orders SET cancel_requested = 1 WHERE pair_id = ? AND leg = ? AND seq = ? AND cancel_requested = 0',
      ).run(o.pairId, o.leg, o.seq);
      if (marked.changes > 0) {
        const pair = this.getPair(o.pairId)!;
        this.updatePair(o.pairId, { repriceCount: pair.repriceCount + 1 });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Allocate the next seq and insert a PENDING order in ONE transaction —
   * the write-ahead reservation. Returns the inserted row.
   *
   * The client text hashes the deal id (FNV-1a → base36):
   * deal ids are client-minted UUIDs (~36 chars) but Gate's order text caps at
   * 28 bytes — 't' + 7-char hash + leg + seq stays ≤ ~11 chars with negligible
   * collision odds, and the text is still deterministic from durable state (the
   * id + seq), which the resolution ladder requires. Gate CrossEx rejects any
   * non-alphanumeric text (TRADE_CLIENT_ORDER_ID_MATCH_ERROR, "Text only support
   * letters and numbers"), so NO separators: 't'+base36 hash+A/B+digits is all
   * letters and numbers, and the uppercase leg marks the hash/seq boundary. */
  insertPendingOrder(o: {
    pairId: string;
    leg: OrderRow['leg'];
    kind: OrderRow['kind'];
    side: OrderRow['side'];
    qty: string;
    price: string | null;
    tif: OrderRow['tif'];
    now: number;
  }): OrderRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM orders WHERE pair_id = ? AND leg = ?')
        .get(o.pairId, o.leg) as unknown as { next: number };
      const clientId = `t${fnv1a36(o.pairId.toLowerCase())}${o.leg}${next}`;
      this.db
        .prepare(
          `INSERT INTO orders (pair_id, leg, seq, client_id, kind, side, qty, price, tif,
             state, cum_qty, cancel_requested, created_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', '0', 0, ?)`,
        )
        .run(o.pairId, o.leg, next, clientId, o.kind, o.side, o.qty, o.price, o.tif, o.now);
      this.db.exec('COMMIT');
      return {
        pairId: o.pairId,
        leg: o.leg,
        seq: next,
        clientId,
        kind: o.kind,
        side: o.side,
        qty: o.qty,
        price: o.price,
        tif: o.tif,
        state: 'PENDING',
        venueOrderId: null,
        cumQty: '0',
        avgFillPrice: '0',
        readFailStreak: 0,
        closeReason: null,
        cancelRequested: 0,
        quarantinedStatus: null,
        venueReason: null,
        createdAt: o.now,
        resolvedAt: null,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listOrders(pairId: string): OrderRow[] {
    return (
      this.db
        .prepare('SELECT * FROM orders WHERE pair_id = ? ORDER BY created_at, leg, seq')
        .all(pairId) as unknown as OrderDbRow[]
    ).map(toOrder);
  }

  /** Find a LIVE engine-owned order by EITHER identifier a caller might hold.
   * The venue accepts our client TEXT on cancel just as it accepts its own
   * numeric id — venueGate.cancel relies on exactly that — so a guard keyed on
   * the venue id alone is bypassable by anyone holding the client text (it
   * rides in /api/deals and in the venue's `text` field on /api/orders/open).
   * NOCASE on the text: if the venue matches it case-insensitively, a
   * case-mangled id must not slip past a BINARY comparison. */
  findLiveEngineOrder(id: string): OrderRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE (venue_order_id = ? OR client_id = ? COLLATE NOCASE)
           AND state IN ('PENDING','OPEN') LIMIT 1`,
      )
      .get(id, id) as unknown as OrderDbRow | undefined;
    return r ? toOrder(r) : null;
  }

  /** True while some live engine order's venue id is still unknown to the
   * ledger (its create returned 'unknown', or the confirming read is still
   * owed). In that window the ledger alone cannot disprove that a venue id
   * handed to us belongs to the engine. */
  hasLiveOrderAwaitingVenueId(): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM orders WHERE venue_order_id IS NULL AND state IN ('PENDING','OPEN') LIMIT 1`,
        )
        .get() !== undefined
    );
  }

  updateOrder(pairId: string, leg: OrderRow['leg'], seq: number, patch: OrderPatch): void {
    const keys = Object.keys(patch) as Array<keyof OrderPatch>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${ORDER_COLS[k]} = ?`).join(', ');
    this.db
      .prepare(`UPDATE orders SET ${sets} WHERE pair_id = ? AND leg = ? AND seq = ?`)
      .run(...keys.map((k) => patch[k] as never), pairId, leg, seq);
  }

  /** Quantity-weighted average fill price for a leg — Σ(cum·avg) ÷ Σ(cum) over
   * the leg's ORDER rows, each weighted by its venue-reported cumulative fill and
   * average execution price. This is the price the leg actually executed at
   * across every partial + re-peg (leg A) or every clip (leg B), and is the ONLY
   * fill price available for a market/IOC hedge (whose order price is null).
   * Orders that never filled (cum 0) or lack a venue avg (0) are skipped; null
   * when no order on the leg has a usable fill. A malformed venue price is
   * skipped rather than crashing the fold. */
  avgFillPrice(pairId: string, leg: string): string | null {
    const rows = this.db
      .prepare('SELECT cum_qty, avg_fill_price FROM orders WHERE pair_id = ? AND leg = ?')
      .all(pairId, leg) as unknown as { cum_qty: string; avg_fill_price: string }[];
    let notional = FX_ZERO;
    let qtySum = FX_ZERO;
    for (const r of rows) {
      let cum: bigint;
      let avg: bigint;
      try {
        cum = fx(r.cum_qty);
        avg = fx(r.avg_fill_price);
      } catch {
        continue; // unparseable venue value — leave it out of the average
      }
      if (cum <= FX_ZERO || avg <= FX_ZERO) continue;
      qtySum += cum;
      notional += fxMul(cum, avg);
    }
    if (qtySum === FX_ZERO) return null;
    return fxStr(fxDiv(notional, qtySum));
  }

  /** Finished two-leg deals with both legs' realized fills, for the strategy
   * view's entry-slippage chain. Excluded by SQL: single-leg deals (no gap to
   * speak of) and both-reduce-only deals (those are exits, not entries — a
   * one-reduce/one-open venue migration stays in). Rows whose report_json is
   * missing or unusable are skipped rather than surfaced: the chain's qty
   * reconciliation then fails and the strategy falls back to its honest
   * "unknown" answer — never a wrong sum built on a partial read. */
  dealFillReports(): DealFillReportRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, a_contract, a_side, b_contract, b_side, report_json, created_at FROM pair
         WHERE mode = 'DONE' AND b_contract IS NOT NULL
           AND NOT (a_reduce_only = 1 AND b_reduce_only = 1)
         ORDER BY created_at`,
      )
      .all() as unknown as {
      id: string;
      a_contract: string;
      a_side: string;
      b_contract: string;
      b_side: string;
      report_json: string | null;
      created_at: number;
    }[];
    const out: DealFillReportRow[] = [];
    for (const r of rows) {
      let report: { aFilled?: unknown; bFilled?: unknown; aAvgFill?: unknown; bAvgFill?: unknown };
      try {
        report = JSON.parse(r.report_json ?? '') as typeof report;
      } catch {
        continue;
      }
      const str = (v: unknown): string | null =>
        typeof v === 'string' && Number.isFinite(Number(v)) && Number(v) > 0 ? v : null;
      const aFilled = str(report.aFilled);
      const bFilled = str(report.bFilled);
      const aAvgFill = str(report.aAvgFill);
      const bAvgFill = str(report.bAvgFill);
      if (!aFilled || !bFilled || !aAvgFill || !bAvgFill) continue;
      out.push({
        dealId: r.id,
        aContract: r.a_contract,
        aSide: r.a_side,
        bContract: r.b_contract,
        bSide: r.b_side,
        aFilled,
        bFilled,
        aAvgFill,
        bAvgFill,
        createdAtMs: r.created_at,
      });
    }
    return out;
  }

  alert(
    level: AlertRow['level'],
    pairId: string | null,
    message: string,
    now: number,
    opts?: { once?: boolean },
  ): void {
    // Deduplicate identical unacked alerts: alerts are LEVELS the UI re-renders,
    // not events — one row per distinct standing condition. `once` also dedupes
    // against ACKED rows (one-time notices like the legacy migration guard must not
    // re-nag after every restart).
    const existing = this.db
      .prepare(
        opts?.once
          ? 'SELECT id FROM alert_log WHERE pair_id IS ? AND message = ?'
          : 'SELECT id FROM alert_log WHERE ack = 0 AND pair_id IS ? AND message = ?',
      )
      .get(pairId, message);
    if (existing) return;
    this.db
      .prepare('INSERT INTO alert_log (ts, level, pair_id, message, ack) VALUES (?,?,?,?,0)')
      .run(now, level, pairId, message);
  }

  listAlerts(opts?: { unackedOnly?: boolean }): AlertRow[] {
    const sql = opts?.unackedOnly
      ? 'SELECT * FROM alert_log WHERE ack = 0 ORDER BY id'
      : 'SELECT * FROM alert_log ORDER BY id';
    return this.db.prepare(sql).all() as unknown as AlertRow[];
  }

  ackAlert(id: number): void {
    this.db.prepare('UPDATE alert_log SET ack = 1 WHERE id = ?').run(id);
  }
}
