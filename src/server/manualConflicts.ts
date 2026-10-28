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
import { fx } from '../engine/fx';

export interface ManualConflictSources {
  store: Store;
  /** A body that is not a list is unreadable, never "none". */
  readPositions: () => Promise<unknown>;
  readOpenOrders: () => Promise<unknown>;
}

export type ManualGate = { ok: true } | { ok: false; label: 'manual-conflict' | 'manual-unverifiable'; message: string };

const upper = (contracts: readonly string[]): Set<string> => new Set(contracts.map((c) => c.toUpperCase()));

/** Unfinished engine deals with a leg on any of `contracts` — synchronous, so
 * it can be re-checked with no await before the deal row is written. */
export function activeDealsOn(store: Store, contracts: readonly string[]): string[] {
  const wanted = upper(contracts);
  return store
    .listPairs({ activeOnly: true })
    .filter((p) => wanted.has(p.a.contract.toUpperCase()) || (p.b !== null && wanted.has(p.b.contract.toUpperCase())))
    .map((p) => p.id);
}

/** A zero size is the only "not held"; an unreadable one counts as held. */
function held(qty: unknown): boolean {
  try {
    return fx(String(qty ?? '0')) !== 0n;
  } catch {
    return true;
  }
}

function rows(body: unknown, what: string): Array<{ symbol?: string; positionQty?: unknown }> {
  if (!Array.isArray(body)) throw new Error(`${what} came back unreadable`);
  return body as Array<{ symbol?: string; positionQty?: unknown }>;
}

export async function manualGate(contracts: readonly string[], sources: ManualConflictSources): Promise<ManualGate> {
  const wanted = upper(contracts);
  const deals = activeDealsOn(sources.store, contracts);
  if (deals.length) {
    return { ok: false, label: 'manual-conflict', message: `an unfinished deal already works ${[...wanted].join(', ')} (${deals.join(', ')}). Wait for it to finish or stop it first.` };
  }
  let positions: ReturnType<typeof rows>;
  let orders: ReturnType<typeof rows>;
  try {
    const [p, o] = await Promise.all([sources.readPositions(), sources.readOpenOrders()]);
    positions = rows(p, 'positions');
    orders = rows(o, 'open orders');
  } catch (err) {
    return { ok: false, label: 'manual-unverifiable', message: `could not read positions and open orders to check for conflicts (${(err as Error).message}); nothing was created` };
  }
  const heldOn = positions.filter((p) => wanted.has((p.symbol ?? '').toUpperCase()) && held(p.positionQty)).map((p) => p.symbol);
  if (heldOn.length) {
    return { ok: false, label: 'manual-conflict', message: `a position is already open on ${heldOn.join(', ')}, and which strategy it belongs to is not proven. A stand-alone ticket cannot add to it; close it, or open through its strategy.` };
  }
  const working = orders.filter((o) => wanted.has((o.symbol ?? '').toUpperCase())).map((o) => o.symbol);
  if (working.length) {
    return { ok: false, label: 'manual-conflict', message: `an open order is already working on ${[...new Set(working)].join(', ')}. Cancel it or let it finish first.` };
  }
  return { ok: true };
}
