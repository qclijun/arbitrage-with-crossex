/** Read-only queries over the slice ledger (ticket 15; engine/slices.ts). */
import type { DatabaseSync } from 'node:sqlite';
import { fx, fxStr } from './fx';
import { ACCOUNT, filledOn, normContract } from './slice-booking';
import type { ContractState } from './slice-reconcile';

export type SliceSide = 'long' | 'short';
export interface SliceLegView { leg: string; account: string; contract: string; side: SliceSide; unit: string; qty: string }
export interface SliceView { id: string; kind: string; source: unknown; createdAt: number; legs: SliceLegView[] }
export interface Movement {
  id: number; sliceId: string | null; leg: string | null; contract: string; delta: string; kind: string;
  dealId: string | null; dealLeg: string | null; observedAt: number; evidence: string | null;
}
export interface ContractBook { explained: string; baselineAt: number; flag: string | null }

export function getSlice(db: DatabaseSync, id: string): SliceView | null {
  const row = db.prepare('SELECT * FROM strategy_slice WHERE id = ?').get(id) as { id: string; kind: string; source_json: string; created_at: number } | undefined;
  if (!row) return null;
  const legs = db.prepare('SELECT leg, account, contract, side, unit, qty FROM slice_leg WHERE slice_id = ? ORDER BY rowid').all(id) as unknown as SliceLegView[];
  return { id: row.id, kind: row.kind, source: JSON.parse(row.source_json), createdAt: row.created_at, legs };
}

export function listSlices(db: DatabaseSync): SliceView[] {
  return (db.prepare('SELECT id FROM strategy_slice ORDER BY created_at, id').all() as { id: string }[]).map((r) => getSlice(db, r.id)!);
}

export function movementsOf(db: DatabaseSync, sliceId: string | null): Movement[] {
  return (db.prepare('SELECT * FROM slice_movement WHERE slice_id IS ? ORDER BY id').all(sliceId) as Array<Record<string, unknown>>).map((m) => ({
    id: m.id as number, sliceId: m.slice_id as string | null, leg: m.leg as string | null, contract: m.contract as string,
    delta: m.delta as string, kind: m.kind as string, dealId: m.deal_id as string | null, dealLeg: m.deal_leg as string | null,
    observedAt: m.observed_at as number, evidence: m.evidence as string | null,
  }));
}

export function bookOf(db: DatabaseSync, contract: string): ContractBook | null {
  const row = db.prepare('SELECT explained, baseline_at, flag FROM contract_book WHERE account = ? AND contract = ?')
    .get(ACCOUNT, normContract(contract)) as { explained: string; baseline_at: number; flag: string | null } | undefined;
  return row ? { explained: row.explained, baselineAt: row.baseline_at, flag: row.flag } : null;
}

export function trackedContracts(db: DatabaseSync): string[] {
  return (db.prepare('SELECT contract FROM contract_book WHERE account = ? ORDER BY contract').all(ACCOUNT) as { contract: string }[]).map((r) => r.contract);
}

/** An unfinished deal (any mode but DONE, HALTED included) touches the contract. */
export function inFlight(db: DatabaseSync, contract: string): boolean {
  const c = normContract(contract);
  return db.prepare("SELECT 1 FROM pair WHERE mode != 'DONE' AND (upper(a_contract) = ? OR upper(b_contract) = ?) LIMIT 1").get(c, c) !== undefined;
}

export function legsOn(db: DatabaseSync, contract: string): ContractState['legs'] {
  return db.prepare('SELECT slice_id AS sliceId, leg, side, qty FROM slice_leg WHERE account = ? AND contract = ? ORDER BY rowid')
    .all(ACCOUNT, normContract(contract)) as unknown as ContractState['legs'];
}

export function contractStateOf(db: DatabaseSync, contract: string): ContractState {
  const c = normContract(contract);
  const book = bookOf(db, c);
  return { contract: c, explained: book?.explained ?? null, flag: book?.flag ?? null, inFlight: inFlight(db, c), legs: legsOn(db, c) };
}

/** A slice holding `contract` the other way: a leg with quantity, or one an
 * unfinished open/add deal is filling. */
export function oppositeHolder(db: DatabaseSync, contract: string, side: SliceSide): string | null {
  const row = db.prepare(
    `SELECT sl.slice_id FROM slice_leg sl
     WHERE sl.account = ? AND sl.contract = ? AND sl.side != ?
       AND (sl.qty NOT IN ('0', '') OR EXISTS (
         SELECT 1 FROM deal_slice ds JOIN pair p ON p.id = ds.deal_id
         WHERE ds.slice_id = sl.slice_id AND ds.action != 'reduce' AND p.mode != 'DONE'))
     LIMIT 1`,
  ).get(ACCOUNT, normContract(contract), side) as { slice_id: string } | undefined;
  return row?.slice_id ?? null;
}

/** Per slice leg: actual qty, what unfinished reduce deals still reserve, and
 * what is left to reduce. */
export function reducibleOf(db: DatabaseSync, slice: SliceView): Record<string, { qty: string; reserved: string; reducible: string }> {
  const rows = db.prepare(
    `SELECT ds.deal_id, ds.a_leg, ds.b_leg, p.target_qty FROM deal_slice ds JOIN pair p ON p.id = ds.deal_id
     WHERE ds.slice_id = ? AND ds.action = 'reduce' AND p.mode != 'DONE'`,
  ).all(slice.id) as Array<{ deal_id: string; a_leg: string; b_leg: string | null; target_qty: string }>;
  const out: Record<string, { qty: string; reserved: string; reducible: string }> = {};
  for (const l of slice.legs) {
    let reserved = 0n;
    for (const r of rows) {
      const dealLeg = r.a_leg === l.leg ? 'A' : r.b_leg === l.leg ? 'B' : null;
      if (!dealLeg) continue;
      const left = fx(r.target_qty) - (filledOn(db, r.deal_id, dealLeg) ?? 0n);
      if (left > 0n) reserved += left;
    }
    const left = fx(l.qty) - reserved;
    out[l.leg] = { qty: l.qty, reserved: fxStr(reserved), reducible: fxStr(left > 0n ? left : 0n) };
  }
  return out;
}

/** What unfinished reduce-only deal legs on `contract` may still take from the
 * position: target minus filled (an unreadable fill counts as nothing filled). */
export function pendingReduceOn(db: DatabaseSync, contract: string): string {
  const c = normContract(contract);
  const rows = db.prepare(
    `SELECT id, target_qty, CASE WHEN upper(a_contract) = ? AND a_reduce_only = 1 THEN 'A' ELSE 'B' END AS leg
     FROM pair WHERE mode != 'DONE' AND ((upper(a_contract) = ? AND a_reduce_only = 1) OR (upper(b_contract) = ? AND b_reduce_only = 1))`,
  ).all(c, c, c) as Array<{ id: string; target_qty: string; leg: 'A' | 'B' }>;
  let pending = 0n;
  for (const r of rows) {
    const left = fx(r.target_qty) - (filledOn(db, r.id, r.leg) ?? 0n);
    if (left > 0n) pending += left;
  }
  return fxStr(pending);
}
