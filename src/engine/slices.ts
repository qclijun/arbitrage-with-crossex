/**
 * The strategy slice ledger (ticket 15; docs: ownership-and-risk.md).
 *
 * A slice is a long-lived ownership unit — a strategy's legs on exact
 * contracts — that many deals open into, add to and reduce. It holds only
 * ACTUAL quantity: each attached deal leg's cumulative fill, booked once by
 * delta (bookFills, run by the engine every tick; database only). Targets and
 * hedge reservations are never holdings, and nothing moves between slices.
 *
 * Each contract a slice touches has a book: the signed net the ledger can
 * explain — the position observed when it was first tracked (which stays
 * unattributed) plus every engine fill on it since. slice-reconcile.ts judges
 * a fresh reading against it. Unexplained changes are resolved only by an
 * explicit, evidenced recover(); claim() attributes proven unattributed
 * quantity from now on. No FIFO, no pro-rata, no backdating.
 */
import type { DatabaseSync } from 'node:sqlite';
import { fx, fxStr } from './fx';
import { fitsInside, reconcileContract, signedAttribution, type ContractState } from './slice-reconcile';
import { inSavepoint } from './ledger/sqlite';
import { ACCOUNT, bookDealFills, insertMovement } from './slice-booking';
import type { AlertRow } from './types';

export { ACCOUNT };

export type SliceKind = 'funding-two-leg' | 'boros-hedge';
export type SliceSide = 'long' | 'short';
export type SliceAction = 'open' | 'add' | 'reduce';

export type SliceRefusalCode =
  | 'unknown-slice' | 'unknown-deal' | 'invalid-input' | 'leg-mismatch' | 'contract-in-flight'
  | 'opposite-slice' | 'baseline-missing' | 'not-reconciled' | 'exceeds-unattributed' | 'invalid-adjustment';

/** A deliberate "no" that changed nothing. */
export class SliceRefusal extends Error {
  constructor(readonly code: SliceRefusalCode, message: string) {
    super(message);
    this.name = 'SliceRefusal';
  }
}

export interface DealLegShape { contract: string; side: string; reduceOnly?: boolean }
export interface SliceLegView { leg: string; account: string; contract: string; side: SliceSide; unit: string; qty: string }
export interface SliceView { id: string; kind: string; source: unknown; createdAt: number; legs: SliceLegView[] }
export interface Movement {
  id: number; sliceId: string | null; leg: string | null; contract: string; delta: string; kind: string;
  dealId: string | null; dealLeg: string | null; observedAt: number; evidence: string | null;
}

type Alert = (level: AlertRow['level'], pairId: string | null, message: string, now: number) => void;
const no = (code: SliceRefusalCode, message: string): SliceRefusal => new SliceRefusal(code, message);

export class SliceLedger {
  constructor(private readonly db: DatabaseSync, private readonly alert: Alert) {}

  create(input: {
    id: string; kind: SliceKind; source: unknown; now: number;
    legs: Array<{ leg: string; contract: string; side: SliceSide }>;
    /** Signed actual net per contract, read fresh, for contracts not yet tracked. */
    observed: Record<string, string>;
  }): void {
    const contracts = input.legs.map((l) => l.contract.toUpperCase());
    if (!input.id || !input.legs.length || new Set(contracts).size !== contracts.length ||
      new Set(input.legs.map((l) => l.leg)).size !== input.legs.length) {
      throw no('invalid-input', 'a slice needs an id and distinct legs on distinct contracts');
    }
    if (this.get(input.id)) throw no('invalid-input', `slice ${input.id} already exists`);
    inSavepoint(this.db, () => {
      for (const [i, l] of input.legs.entries()) {
        const contract = contracts[i];
        if (this.inFlight(contract)) throw no('contract-in-flight', `execution on ${contract} is in flight; a slice can start only on a settled contract`);
        const opposite = this.legsOn(contract).find((o) => o.side !== l.side && fx(o.qty) > 0n);
        if (opposite) throw no('opposite-slice', `${contract} is held ${opposite.side} by slice ${opposite.sliceId}; slices on one net position must point the same way`);
        if (!this.book(contract)) {
          const seen = input.observed[contract] ?? input.observed[l.contract];
          if (seen === undefined) throw no('baseline-missing', `no fresh position reading for ${contract}`);
          this.db.prepare('INSERT INTO contract_book (account, contract, explained, baseline_at, flag) VALUES (?,?,?,?,NULL)')
            .run(ACCOUNT, contract, fxStr(fx(seen)), input.now);
        }
      }
      this.db.prepare('INSERT INTO strategy_slice (id, kind, source_json, created_at) VALUES (?,?,?,?)')
        .run(input.id, input.kind, JSON.stringify(input.source ?? null), input.now);
      for (const [i, l] of input.legs.entries()) {
        this.db.prepare("INSERT INTO slice_leg (slice_id, leg, account, contract, side, unit, qty) VALUES (?,?,?,?,?,'base','0')")
          .run(input.id, l.leg, ACCOUNT, contracts[i], l.side);
      }
    });
  }

  /** Which slice legs a deal's A/B legs move. They must be the slice's legs,
   * in the slice's direction for open/add and reduce-only against it for
   * reduce. Throws a refusal; writes nothing. */
  mapLegs(sliceId: string, action: SliceAction, legs: { a: DealLegShape; b: DealLegShape | null }): { aLeg: string; bLeg: string | null } {
    const slice = this.get(sliceId);
    if (!slice) throw no('unknown-slice', `unknown slice ${sliceId}`);
    const legFor = (d: DealLegShape): string => {
      const l = slice.legs.find((s) => s.contract === d.contract.toUpperCase());
      const opens = (d.side === 'BUY') === (l?.side === 'long');
      if (!l || (action === 'reduce' ? opens || !d.reduceOnly : !opens || d.reduceOnly)) {
        throw no('leg-mismatch', `${d.side} ${d.contract} does not ${action} a leg of slice ${sliceId}`);
      }
      return l.leg;
    };
    const aLeg = legFor(legs.a);
    const bLeg = legs.b ? legFor(legs.b) : null;
    if (aLeg === bLeg) throw no('leg-mismatch', `both deal legs map to slice leg ${aLeg}`);
    return { aLeg, bLeg };
  }

  /** Name the slice a deal moves (see mapLegs). */
  attach(dealId: string, sliceId: string, action: SliceAction): void {
    const pair = this.db.prepare('SELECT a_contract, a_side, a_reduce_only, b_contract, b_side, b_reduce_only FROM pair WHERE id = ?')
      .get(dealId) as { a_contract: string; a_side: string; a_reduce_only: number; b_contract: string | null; b_side: string | null; b_reduce_only: number } | undefined;
    if (!pair) throw no('unknown-deal', `unknown deal ${dealId}`);
    if (this.db.prepare('SELECT 1 FROM deal_slice WHERE deal_id = ?').get(dealId)) throw no('invalid-input', `deal ${dealId} already names a slice`);
    const { aLeg, bLeg } = this.mapLegs(sliceId, action, {
      a: { contract: pair.a_contract, side: pair.a_side, reduceOnly: pair.a_reduce_only === 1 },
      b: pair.b_contract ? { contract: pair.b_contract, side: pair.b_side!, reduceOnly: pair.b_reduce_only === 1 } : null,
    });
    this.db.prepare('INSERT INTO deal_slice (deal_id, slice_id, action, a_leg, b_leg) VALUES (?,?,?,?,?)')
      .run(dealId, sliceId, action, aLeg, bLeg);
  }

  /** What unfinished reduce-only deal legs on `contract` may still take from
   * the position — their target minus what they already filled. */
  pendingReduce(contract: string): string {
    const c = contract.toUpperCase();
    const rows = this.db.prepare(
      `SELECT p.id, p.target_qty, CASE WHEN upper(p.a_contract) = ? AND p.a_reduce_only = 1 THEN 'A' ELSE 'B' END AS leg
       FROM pair p WHERE p.mode != 'DONE'
         AND ((upper(p.a_contract) = ? AND p.a_reduce_only = 1) OR (upper(p.b_contract) = ? AND p.b_reduce_only = 1))`,
    ).all(c, c, c) as Array<{ id: string; target_qty: string; leg: 'A' | 'B' }>;
    let pending = 0n;
    for (const r of rows) {
      const cums = this.db.prepare('SELECT cum_qty FROM orders WHERE pair_id = ? AND leg = ?').all(r.id, r.leg) as { cum_qty: string }[];
      let filled = 0n;
      for (const o of cums) {
        try {
          filled += fx(o.cum_qty);
        } catch {
          filled += 0n; // unreadable: count the whole target as still pending
        }
      }
      const left = fx(r.target_qty) - filled;
      if (left > 0n) pending += left;
    }
    return fxStr(pending);
  }

  /** Book a deal's newly observed fills — idempotent, by delta, per leg. */
  bookFills(dealId: string, now: number): void {
    inSavepoint(this.db, () => bookDealFills(this.db, this.alert, dealId, now));
  }

  /** Per slice leg: actual qty, what active reduce deals still reserve, and
   * what is left to reduce. */
  reducible(sliceId: string): Record<string, { qty: string; reserved: string; reducible: string }> {
    const slice = this.get(sliceId);
    if (!slice) throw no('unknown-slice', `unknown slice ${sliceId}`);
    const rows = this.db.prepare(
      `SELECT ds.deal_id, ds.a_leg, ds.b_leg, p.target_qty,
         (SELECT booked FROM fill_booking fb WHERE fb.deal_id = ds.deal_id AND fb.deal_leg = 'A') AS a_booked,
         (SELECT booked FROM fill_booking fb WHERE fb.deal_id = ds.deal_id AND fb.deal_leg = 'B') AS b_booked
       FROM deal_slice ds JOIN pair p ON p.id = ds.deal_id
       WHERE ds.slice_id = ? AND ds.action = 'reduce' AND p.mode != 'DONE'`,
    ).all(sliceId) as Array<{ a_leg: string; b_leg: string | null; target_qty: string; a_booked: string | null; b_booked: string | null }>;
    const out: Record<string, { qty: string; reserved: string; reducible: string }> = {};
    for (const l of slice.legs) {
      let reserved = 0n;
      for (const r of rows) {
        const booked = r.a_leg === l.leg ? r.a_booked : r.b_leg === l.leg ? r.b_booked : undefined;
        if (booked === undefined) continue;
        const left = fx(r.target_qty) - fx(booked ?? '0');
        if (left > 0n) reserved += left;
      }
      const left = fx(l.qty) - reserved;
      out[l.leg] = { qty: l.qty, reserved: fxStr(reserved), reducible: fxStr(left > 0n ? left : 0n) };
    }
    return out;
  }

  /** Attribute proven, currently unattributed quantity to a slice from now on
   * (ticket 17's claim). The fresh reading must reconcile exactly. */
  claim(input: { sliceId: string; leg: string; qty: string; observedActual: string; evidence: string; now: number }): void {
    const l = this.get(input.sliceId)?.legs.find((x) => x.leg === input.leg);
    if (!l) throw no('unknown-slice', `unknown slice leg ${input.sliceId}/${input.leg}`);
    const qty = fx(input.qty);
    if (qty <= 0n || !input.evidence.trim()) throw no('invalid-input', 'a claim needs a positive quantity and evidence');
    const rec = reconcileContract(this.contractState(l.contract), input.observedActual);
    if (rec.status !== 'reconciled') {
      throw no('not-reconciled', `${l.contract} is ${rec.status}: the ledger cannot explain the position as observed; reconcile it first`);
    }
    const unattributed = fx(rec.unattributed!);
    const available = l.side === 'long' ? unattributed : -unattributed;
    if (qty > available) throw no('exceeds-unattributed', `only ${fxStr(available > 0n ? available : 0n)} ${l.side} on ${l.contract} is unattributed`);
    inSavepoint(this.db, () => {
      this.setQty(input.sliceId, input.leg, fx(l.qty) + qty);
      this.move(input.sliceId, input.leg, l.contract, qty, 'claim', null, null, input.now, input.evidence);
    });
  }

  /** The user's explicit reconciliation of an unexplained change: the
   * observed position becomes the new explained baseline, with the stated
   * per-slice adjustments; the remainder is unattributed. */
  recover(input: {
    contract: string; observedActual: string; evidence: string; now: number;
    adjustments: Array<{ sliceId: string; leg: string; delta: string }>;
  }): void {
    const contract = input.contract.toUpperCase();
    const book = this.book(contract);
    if (!book) throw no('invalid-input', `${contract} has no slice ledger to recover`);
    if (this.inFlight(contract)) throw no('contract-in-flight', `execution on ${contract} is in flight; recover after it settles`);
    if (!input.evidence.trim()) throw no('invalid-input', 'a recovery needs evidence');
    const legs = this.legsOn(contract).map((l) => ({ ...l }));
    for (const a of input.adjustments) {
      const l = legs.find((x) => x.sliceId === a.sliceId && x.leg === a.leg);
      if (!l) throw no('invalid-adjustment', `slice leg ${a.sliceId}/${a.leg} is not on ${contract}`);
      const next = fx(l.qty) + fx(a.delta);
      if (next < 0n) throw no('invalid-adjustment', `slice ${a.sliceId} cannot go below zero on ${contract}`);
      l.qty = fxStr(next);
    }
    const observed = fx(input.observedActual);
    if (!fitsInside(signedAttribution(legs), observed)) {
      throw no('invalid-adjustment', `the adjusted slices do not fit the observed ${fxStr(observed)} on ${contract}`);
    }
    inSavepoint(this.db, () => {
      for (const a of input.adjustments) {
        const l = legs.find((x) => x.sliceId === a.sliceId && x.leg === a.leg)!;
        this.setQty(a.sliceId, a.leg, fx(l.qty));
        if (fx(a.delta) !== 0n) this.move(a.sliceId, a.leg, contract, fx(a.delta), 'recover', null, null, input.now, input.evidence);
      }
      this.move(null, null, contract, observed - fx(book.explained), 'external', null, null, input.now, input.evidence);
      this.db.prepare('UPDATE contract_book SET explained = ?, baseline_at = ?, flag = NULL WHERE account = ? AND contract = ?')
        .run(fxStr(observed), input.now, ACCOUNT, contract);
    });
  }

  get(id: string): SliceView | null {
    const row = this.db.prepare('SELECT * FROM strategy_slice WHERE id = ?').get(id) as { id: string; kind: string; source_json: string; created_at: number } | undefined;
    if (!row) return null;
    const legs = this.db.prepare('SELECT leg, account, contract, side, unit, qty FROM slice_leg WHERE slice_id = ? ORDER BY rowid').all(id) as unknown as SliceLegView[];
    return { id: row.id, kind: row.kind, source: JSON.parse(row.source_json), createdAt: row.created_at, legs };
  }

  list(): SliceView[] {
    return (this.db.prepare('SELECT id FROM strategy_slice ORDER BY created_at, id').all() as { id: string }[]).map((r) => this.get(r.id)!);
  }

  movements(sliceId: string | null): Movement[] {
    return (this.db.prepare('SELECT * FROM slice_movement WHERE slice_id IS ? ORDER BY id').all(sliceId) as Array<Record<string, unknown>>).map((m) => ({
      id: m.id as number, sliceId: m.slice_id as string | null, leg: m.leg as string | null, contract: m.contract as string,
      delta: m.delta as string, kind: m.kind as string, dealId: m.deal_id as string | null, dealLeg: m.deal_leg as string | null,
      observedAt: m.observed_at as number, evidence: m.evidence as string | null,
    }));
  }

  book(contract: string): { explained: string; baselineAt: number; flag: string | null } | null {
    const row = this.db.prepare('SELECT explained, baseline_at, flag FROM contract_book WHERE account = ? AND contract = ?')
      .get(ACCOUNT, contract.toUpperCase()) as { explained: string; baseline_at: number; flag: string | null } | undefined;
    return row ? { explained: row.explained, baselineAt: row.baseline_at, flag: row.flag } : null;
  }

  /** Contracts with a book, for the read API. */
  trackedContracts(): string[] {
    return (this.db.prepare('SELECT contract FROM contract_book WHERE account = ? ORDER BY contract').all(ACCOUNT) as { contract: string }[]).map((r) => r.contract);
  }

  contractState(contract: string): ContractState {
    const c = contract.toUpperCase();
    const book = this.book(c);
    return { contract: c, explained: book?.explained ?? null, flag: book?.flag ?? null, inFlight: this.inFlight(c), legs: this.legsOn(c) };
  }

  /** An unfinished deal touches the contract. */
  inFlight(contract: string): boolean {
    const c = contract.toUpperCase();
    return this.db.prepare("SELECT 1 FROM pair WHERE mode != 'DONE' AND (upper(a_contract) = ? OR upper(b_contract) = ?) LIMIT 1").get(c, c) !== undefined;
  }

  private legsOn(contract: string): ContractState['legs'] {
    return this.db.prepare('SELECT slice_id AS sliceId, leg, side, qty FROM slice_leg WHERE account = ? AND contract = ? ORDER BY rowid')
      .all(ACCOUNT, contract) as unknown as ContractState['legs'];
  }

  private setQty(sliceId: string, leg: string, qty: bigint): void {
    this.db.prepare('UPDATE slice_leg SET qty = ? WHERE slice_id = ? AND leg = ?').run(fxStr(qty), sliceId, leg);
  }

  private move(sliceId: string | null, leg: string | null, contract: string, delta: bigint, kind: string,
    dealId: string | null, dealLeg: string | null, now: number, evidence: string | null): void {
    insertMovement(this.db, { sliceId, leg, contract, delta, kind, dealId, dealLeg, now, evidence });
  }
}
