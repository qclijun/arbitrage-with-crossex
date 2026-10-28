/**
 * Booking engine fills into the slice ledger (ticket 15) — database only, run
 * by the engine after every tick (loop.ts) and once when the loop starts, so
 * it is the single writer of fill-derived quantities. Per deal leg, the
 * cumulative fill is booked ONCE by delta: a repeated or late observation
 * books only what is new, a shrinking one is refused with an alert (the loop
 * already quarantines it). A fill on a tracked contract moves its explained
 * net if the deal started at or after the contract's baseline (earlier deals
 * are part of the baseline); an attached deal also moves its slice leg. A
 * reduce never takes a slice below zero: the excess is recorded as
 * unattributed and the contract is flagged for explicit recovery.
 */
import type { DatabaseSync } from 'node:sqlite';
import { fx, fxStr } from './fx';
import type { AlertRow } from './types';

/** The one configured CrossEx account; multi-account is not supported. */
export const ACCOUNT = 'crossex';

export const normContract = (contract: string): string => contract.toUpperCase();

export type Alert = (level: AlertRow['level'], pairId: string | null, message: string, now: number) => void;

export type MovementKind = 'fill' | 'excess' | 'claim' | 'recover' | 'external';

export interface MovementInput {
  sliceId: string | null; leg: string | null; contract: string; delta: bigint; kind: MovementKind;
  dealId?: string | null; dealLeg?: string | null; now: number; evidence?: string | null;
}

export function insertMovement(db: DatabaseSync, m: MovementInput): void {
  db.prepare(
    'INSERT INTO slice_movement (slice_id, leg, account, contract, delta, kind, deal_id, deal_leg, observed_at, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(m.sliceId, m.leg, ACCOUNT, m.contract, fxStr(m.delta), m.kind, m.dealId ?? null, m.dealLeg ?? null, m.now, m.evidence ?? null);
}

/** Σ cum over a deal leg's orders; null when a venue value is unreadable. */
export function filledOn(db: DatabaseSync, dealId: string, leg: 'A' | 'B'): bigint | null {
  let sum = 0n;
  for (const r of db.prepare('SELECT cum_qty FROM orders WHERE pair_id = ? AND leg = ?').all(dealId, leg) as { cum_qty: string }[]) {
    try {
      sum += fx(r.cum_qty);
    } catch {
      return null;
    }
  }
  return sum;
}

interface PairLegs { a_contract: string; a_side: string; b_contract: string | null; b_side: string | null; created_at: number }

export function bookDealFills(db: DatabaseSync, alert: Alert, dealId: string, now: number): void {
  const pair = db.prepare('SELECT a_contract, a_side, b_contract, b_side, created_at FROM pair WHERE id = ?').get(dealId) as PairLegs | undefined;
  if (!pair) return;
  const attached = db.prepare('SELECT slice_id, action, a_leg, b_leg FROM deal_slice WHERE deal_id = ?').get(dealId) as
    { slice_id: string; action: string; a_leg: string; b_leg: string | null } | undefined;
  const legs: Array<{ name: 'A' | 'B'; contract: string; side: string }> = [{ name: 'A', contract: normContract(pair.a_contract), side: pair.a_side }];
  if (pair.b_contract) legs.push({ name: 'B', contract: normContract(pair.b_contract), side: pair.b_side! });

  for (const leg of legs) {
    const book = db.prepare('SELECT explained, baseline_at FROM contract_book WHERE account = ? AND contract = ?').get(ACCOUNT, leg.contract) as
      { explained: string; baseline_at: number } | undefined;
    const explains = book !== undefined && pair.created_at >= book.baseline_at;
    if (!explains && !attached) continue;
    const filled = filledOn(db, dealId, leg.name);
    if (filled === null) continue; // the loop quarantines an unreadable cum; book nothing
    const bookedRow = db.prepare('SELECT booked FROM fill_booking WHERE deal_id = ? AND deal_leg = ?').get(dealId, leg.name) as { booked: string } | undefined;
    const booked = fx(bookedRow?.booked ?? '0');
    if (filled < booked) {
      alert('error', dealId, `slice ledger: leg ${leg.name} fill shrank from ${fxStr(booked)} to ${fxStr(filled)}; nothing unbooked`, now);
      continue;
    }
    const delta = filled - booked;
    if (delta === 0n) continue;
    db.prepare('INSERT INTO fill_booking (deal_id, deal_leg, booked) VALUES (?,?,?) ON CONFLICT (deal_id, deal_leg) DO UPDATE SET booked = excluded.booked')
      .run(dealId, leg.name, fxStr(filled));
    if (explains) {
      const signed = leg.side === 'BUY' ? delta : -delta;
      db.prepare('UPDATE contract_book SET explained = ? WHERE account = ? AND contract = ?').run(fxStr(fx(book!.explained) + signed), ACCOUNT, leg.contract);
    }
    const sliceLeg = attached ? (leg.name === 'A' ? attached.a_leg : attached.b_leg) : null;
    if (!attached || !sliceLeg) continue;
    const qty = fx((db.prepare('SELECT qty FROM slice_leg WHERE slice_id = ? AND leg = ?').get(attached.slice_id, sliceLeg) as { qty: string }).qty);
    const reduce = attached.action === 'reduce';
    const take = reduce ? (delta < qty ? delta : qty) : delta;
    if (take > 0n) {
      db.prepare('UPDATE slice_leg SET qty = ? WHERE slice_id = ? AND leg = ?').run(fxStr(reduce ? qty - take : qty + take), attached.slice_id, sliceLeg);
      insertMovement(db, { sliceId: attached.slice_id, leg: sliceLeg, contract: leg.contract, delta: reduce ? -take : take, kind: 'fill', dealId, dealLeg: leg.name, now });
    }
    const excess = delta - take;
    if (excess > 0n) {
      const why = `reduce ${dealId} exceeded slice ${attached.slice_id}/${sliceLeg} by ${fxStr(excess)}`;
      insertMovement(db, { sliceId: null, leg: null, contract: leg.contract, delta: -excess, kind: 'excess', dealId, dealLeg: leg.name, now, evidence: why });
      db.prepare('UPDATE contract_book SET flag = ? WHERE account = ? AND contract = ?').run(why, ACCOUNT, leg.contract);
      alert('error', dealId, `slice ledger: ${why}; ${leg.contract} needs an explicit reconciliation`, now);
    }
  }
}

/** Book every deal the ledger follows — attached, or on a tracked contract
 * since its baseline. Idempotent; catches fills a crash or a failed booking
 * left behind on a deal the loop no longer ticks. */
export function bookPendingFills(db: DatabaseSync, alert: Alert, now: number): void {
  const ids = db.prepare(
    `SELECT p.id FROM pair p
     WHERE EXISTS (SELECT 1 FROM deal_slice ds WHERE ds.deal_id = p.id)
        OR EXISTS (SELECT 1 FROM contract_book cb WHERE cb.account = ?
             AND (cb.contract = upper(p.a_contract) OR cb.contract = upper(p.b_contract)) AND p.created_at >= cb.baseline_at)
     ORDER BY p.created_at`,
  ).all(ACCOUNT) as { id: string }[];
  for (const { id } of ids) bookDealFills(db, alert, id, now);
}
