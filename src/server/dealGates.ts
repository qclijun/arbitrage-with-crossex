/**
 * The gates a POST /deals passes after its rules resolve (tickets 19, 15):
 * once on fresh reads BEFORE any leverage is touched, and once more,
 * synchronously, right before the deal row is written — nothing can start in
 * between. A stand-alone ('manual') open must find its contracts free
 * (manualConflicts.ts); a reduce that names a strategy slice may take only
 * what that slice actually holds and what the account can still reduce,
 * after every unfinished reduction already reserved its share.
 */
import type { Clients } from '../core/clients';
import type { ErrorCategory } from '../core/errors';
import type { Store } from '../engine/db';
import { fx, fxStr } from '../engine/fx';
import { SliceRefusal } from '../engine/slices';
import type { DealPurpose, PairRow } from '../engine/types';
import type { BorosContext } from './dealPurpose';
import { activeDealsOn, manualGate } from './manualConflicts';

export interface GateRefusal { code: number; category: ErrorCategory; label: string; message: string; retryable: boolean }

export interface DealDeclaration { purpose: DealPurpose; context: BorosContext | null; sliceId: string | null }

/** What the pre-leverage pass found, for the final re-check. */
export interface Gated { manualContracts: string[]; positions: Map<string, bigint> | null }

const refusal = (code: number, label: string, message: string, category: ErrorCategory = 'validation', retryable = false): GateRefusal =>
  ({ code, category, label, message, retryable });

const fromSlice = (err: unknown): GateRefusal => {
  if (!(err instanceof SliceRefusal)) throw err;
  return refusal(err.code === 'unknown-slice' || err.code === 'leg-mismatch' ? 400 : 409, `slice-${err.code}`, err.message);
};

/** Signed live positions by contract; throws when the body is unreadable. */
async function livePositions(clients: Clients): Promise<Map<string, bigint>> {
  const body = (await clients.crossEx.listCrossexPositions()).body as unknown;
  if (!Array.isArray(body)) throw new Error('positions came back unreadable');
  const out = new Map<string, bigint>();
  for (const p of body as Array<{ symbol?: string; positionQty?: unknown }>) {
    out.set((p.symbol ?? '').toUpperCase(), fx(String(p.positionQty ?? '0')));
  }
  return out;
}

/** The slice reduce's room, judged against `positions` (signed, by contract). */
function sliceRoom(store: Store, row: PairRow, sliceId: string, positions: Map<string, bigint>): GateRefusal | null {
  let mapped: { aLeg: string; bLeg: string | null };
  try {
    mapped = store.slices.mapLegs(sliceId, 'reduce', { a: row.a, b: row.b });
  } catch (err) {
    return fromSlice(err);
  }
  const room = store.slices.reducible(sliceId);
  const qty = fx(row.targetQty);
  for (const [leg, deal] of [[mapped.aLeg, row.a], [mapped.bLeg, row.b]] as const) {
    if (!leg || !deal) continue;
    if (qty > fx(room[leg].reducible)) {
      return refusal(409, 'slice-insufficient', `slice ${sliceId} can reduce ${room[leg].reducible} on ${deal.contract} (holds ${room[leg].qty}, ${room[leg].reserved} already reserved by unfinished reductions)`);
    }
    const held = positions.get(deal.contract.toUpperCase()) ?? 0n;
    const free = (held < 0n ? -held : held) - fx(store.slices.pendingReduce(deal.contract));
    if (qty > free) {
      return refusal(409, 'position-insufficient', `${deal.contract} can still be reduced by ${fxStr(free > 0n ? free : 0n)} after unfinished reductions; nothing was created`);
    }
  }
  return null;
}

export async function gateBeforeLeverage(store: Store, clients: Clients, row: PairRow, d: DealDeclaration): Promise<GateRefusal | Gated> {
  if (d.sliceId !== null && d.purpose !== 'reduce') {
    return refusal(400, 'slice-purpose', 'opening or adding to a strategy slice goes through its own admission; only a reduce names a slice here');
  }
  const manualContracts = d.purpose === 'manual'
    ? [row.a, row.b].filter((leg): leg is NonNullable<typeof leg> => leg !== null && !leg.reduceOnly).map((leg) => leg.contract)
    : [];
  if (manualContracts.length) {
    const gate = await manualGate(manualContracts, {
      store,
      readPositions: async () => (await clients.crossEx.listCrossexPositions()).body,
      readOpenOrders: async () => (await clients.crossEx.listCrossexOpenOrders({})).body,
    });
    if (!gate.ok) {
      const unread = gate.label === 'manual-unverifiable';
      return refusal(unread ? 503 : 409, gate.label, gate.message, unread ? 'network' : 'validation', unread);
    }
  }
  if (d.sliceId === null) return { manualContracts, positions: null };
  let positions: Map<string, bigint>;
  try {
    positions = await livePositions(clients);
  } catch (err) {
    return refusal(503, 'slice-unverifiable', `could not read positions to check the reduction (${(err as Error).message}); nothing was created`, 'network', true);
  }
  return sliceRoom(store, row, d.sliceId, positions) ?? { manualContracts, positions };
}

/** Re-check with no await before writeDeal. */
export function gateBeforeWrite(store: Store, row: PairRow, d: DealDeclaration, gated: Gated): GateRefusal | null {
  const started = activeDealsOn(store, gated.manualContracts);
  if (started.length) {
    return refusal(409, 'manual-conflict', `an unfinished deal started on ${gated.manualContracts.join(', ')} meanwhile (${started.join(', ')}); nothing was created.`);
  }
  return d.sliceId !== null && gated.positions ? sliceRoom(store, row, d.sliceId, gated.positions) : null;
}

/** Write the deal and, when it names one, its slice — together or not at all. */
export function writeDeal(store: Store, row: PairRow, d: DealDeclaration): void {
  store.atomically(() => {
    store.createPair({ ...row, purpose: d.purpose, purposeContext: d.context ? JSON.stringify(d.context) : null });
    if (d.sliceId !== null) store.slices.attach(row.id, d.sliceId, 'reduce');
  });
}
