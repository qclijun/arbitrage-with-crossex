/**
 * Booking engine fills into the slice ledger (ticket 15) — database only, run
 * by the engine after every tick (loop.ts), so it is the single writer of
 * these quantities. Per deal leg, the cumulative fill is booked ONCE by delta:
 * a repeated or late observation books only what is new, a shrinking one is
 * refused with an alert (the loop already quarantines it). Every fill on a
 * tracked contract moves its explained net; an attached deal also moves its
 * slice leg. A reduce never takes a slice below zero: the excess is recorded
 * as unattributed and the contract is flagged for explicit recovery.
 */
import type { DatabaseSync } from 'node:sqlite';
import { fx, fxStr } from './fx';
import type { AlertRow } from './types';

/** The one configured CrossEx account; multi-account is not supported. */
export const ACCOUNT = 'crossex';

type Alert = (level: AlertRow['level'], pairId: string | null, message: string, now: number) => void;

export function insertMovement(db: DatabaseSync, m: {
  sliceId: string | null; leg: string | null; contract: string; delta: bigint; kind: string;
  dealId: string | null; dealLeg: string | null; now: number; evidence: string | null;
}): void {
  db.prepare(
    'INSERT INTO slice_movement (slice_id, leg, account, contract, delta, kind, deal_id, deal_leg, observed_at, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(m.sliceId, m.leg, ACCOUNT, m.contract, fxStr(m.delta), m.kind, m.dealId, m.dealLeg, m.now, m.evidence);
}

interface DealLeg { name: 'A' | 'B'; contract: string; side: string }

function filledOn(db: DatabaseSync, dealId: string, leg: 'A' | 'B'): bigint | null {
  const rows = db.prepare('SELECT cum_qty FROM orders WHERE pair_id = ? AND leg = ?').all(dealId, leg) as { cum_qty: string }[];
  let sum = 0n;
  for (const r of rows) {
    try {
      sum += fx(r.cum_qty);
    } catch {
      return null; // unreadable venue value: the loop quarantines it; book nothing
    }
  }
  return sum;
}

export function bookDealFills(db: DatabaseSync, alert: Alert, dealId: string, now: number): void {
  const pair = db.prepare('SELECT a_contract, a_side, b_contract, b_side FROM pair WHERE id = ?').get(dealId) as
    { a_contract: string; a_side: string; b_contract: string | null; b_side: string | null } | undefined;
  if (!pair) return;
  const attached = db.prepare('SELECT slice_id, action, a_leg, b_leg FROM deal_slice WHERE deal_id = ?').get(dealId) as
    { slice_id: string; action: string; a_leg: string; b_leg: string | null } | undefined;
  const legs: DealLeg[] = [{ name: 'A', contract: pair.a_contract.toUpperCase(), side: pair.a_side }];
  if (pair.b_contract) legs.push({ name: 'B', contract: pair.b_contract.toUpperCase(), side: pair.b_side! });

  for (const leg of legs) {
    const book = db.prepare('SELECT explained FROM contract_book WHERE account = ? AND contract = ?').get(ACCOUNT, leg.contract) as { explained: string } | undefined;
    if (!book && !attached) continue;
    const filled = filledOn(db, dealId, leg.name);
    if (filled === null) continue;
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
    if (book) {
      const signed = leg.side === 'BUY' ? delta : -delta;
      db.prepare('UPDATE contract_book SET explained = ? WHERE account = ? AND contract = ?')
        .run(fxStr(fx(book.explained) + signed), ACCOUNT, leg.contract);
    }
    if (!attached) continue;
    const sliceLeg = leg.name === 'A' ? attached.a_leg : attached.b_leg;
    if (!sliceLeg) continue;
    const current = db.prepare('SELECT qty FROM slice_leg WHERE slice_id = ? AND leg = ?').get(attached.slice_id, sliceLeg) as { qty: string };
    const qty = fx(current.qty);
    const reduce = attached.action === 'reduce';
    const take = reduce ? (delta < qty ? delta : qty) : delta;
    if (take > 0n) {
      db.prepare('UPDATE slice_leg SET qty = ? WHERE slice_id = ? AND leg = ?').run(fxStr(reduce ? qty - take : qty + take), attached.slice_id, sliceLeg);
      insertMovement(db, { sliceId: attached.slice_id, leg: sliceLeg, contract: leg.contract, delta: reduce ? -take : take, kind: 'fill', dealId, dealLeg: leg.name, now, evidence: null });
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
