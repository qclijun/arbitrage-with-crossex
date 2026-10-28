/**
 * The conflict gate for a stand-alone ('manual') open (ticket 19). A manual
 * open is admitted only where nothing it would add to is already held or
 * working: no position on the contract (whose ownership the ledger cannot yet
 * prove), no unfinished engine deal touching it, and no open venue order on
 * it. Every source is read fresh; a source that cannot be read refuses — an
 * unknown is never a pass. Only the contracts the open adds risk to are
 * gated; a reduce-only leg is proven against its position in resolveDeal.
 */
import type { Store } from '../engine/db';

export interface ManualConflictSources {
  store: Store;
  readPositions: () => Promise<Array<{ symbol?: string; positionQty?: unknown }>>;
  readOpenOrders: () => Promise<Array<{ symbol?: string }>>;
}

export type ManualGate = { ok: true } | { ok: false; label: 'manual-conflict' | 'manual-unverifiable'; message: string };

/** Unfinished engine deals with a leg on any of `contracts` — synchronous, so
 * it can be re-checked with no await before the deal row is written. */
export function activeDealsOn(store: Store, contracts: readonly string[]): string[] {
  const wanted = new Set(contracts.map((c) => c.toUpperCase()));
  return store
    .listPairs({ activeOnly: true })
    .filter((p) => wanted.has(p.a.contract.toUpperCase()) || (p.b !== null && wanted.has(p.b.contract.toUpperCase())))
    .map((p) => p.id);
}

function nonZero(qty: unknown): boolean {
  const n = Number(qty ?? 0);
  return !Number.isFinite(n) || n !== 0; // an unreadable size counts as held
}

export async function manualGate(contracts: readonly string[], sources: ManualConflictSources): Promise<ManualGate> {
  const wanted = new Set(contracts.map((c) => c.toUpperCase()));
  const deals = activeDealsOn(sources.store, contracts);
  if (deals.length) {
    return { ok: false, label: 'manual-conflict', message: `an unfinished deal already works ${[...wanted].join(', ')} (${deals.join(', ')}). Wait for it to finish or stop it first.` };
  }
  let positions: Awaited<ReturnType<ManualConflictSources['readPositions']>>;
  let orders: Awaited<ReturnType<ManualConflictSources['readOpenOrders']>>;
  try {
    [positions, orders] = await Promise.all([sources.readPositions(), sources.readOpenOrders()]);
  } catch (err) {
    return { ok: false, label: 'manual-unverifiable', message: `could not read positions and open orders to check for conflicts (${(err as Error).message}); nothing was created` };
  }
  const held = positions.filter((p) => wanted.has((p.symbol ?? '').toUpperCase()) && nonZero(p.positionQty)).map((p) => p.symbol);
  if (held.length) {
    return { ok: false, label: 'manual-conflict', message: `a position is already open on ${held.join(', ')}, and which strategy it belongs to is not proven. A stand-alone ticket cannot add to it; close it, or open through its strategy.` };
  }
  const working = orders.filter((o) => wanted.has((o.symbol ?? '').toUpperCase())).map((o) => o.symbol);
  if (working.length) {
    return { ok: false, label: 'manual-conflict', message: `an open order is already working on ${[...new Set(working)].join(', ')}. Cancel it or let it finish first.` };
  }
  return { ok: true };
}
