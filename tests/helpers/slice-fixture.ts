/** Store-level fixtures for the strategy slice ledger (ticket 15). */
import { Store } from '../../src/engine/db';
import type { PairRow, Side } from '../../src/engine/types';

export const LONG_C = 'BINANCE_FUTURE_ETH_USDT';
export const SHORT_C = 'OKX_FUTURE_ETH_USDT';
export const OTHER_C = 'GATE_FUTURE_BTC_USDT';

const leg = (contract: string, side: Side, reduceOnly = false) => ({
  contract, side, lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01', ...(reduceOnly ? { reduceOnly: true } : {}),
});

/** A deal row: A on `a`, optional B on `b`, created at `createdAt`. */
export function deal(
  store: Store,
  id: string,
  a: { contract: string; side: Side; reduceOnly?: boolean },
  b: { contract: string; side: Side; reduceOnly?: boolean } | null,
  qty: string,
  opts: { mode?: PairRow['mode']; createdAt?: number } = {},
): void {
  store.createPair({
    id, mode: opts.mode ?? 'OPENING',
    a: leg(a.contract, a.side, a.reduceOnly), b: b ? leg(b.contract, b.side, b.reduceOnly) : null,
    targetQty: qty, limitPrice: '2500', pricePolicy: 'fixed', autoPricePolicy: 'touch', deadlineAt: null,
    makerNotBefore: 0, hedgeNotBefore: 0, pocRejects: 0, hedgeRejectStreak: 0, repriceCount: 0,
    lastMakerPlacementAt: 0, postOnlyRejects: 0, bookOutageStartedAt: 0, maxClip: null, clipBandBp: null,
    haltReason: null, reportJson: null, createdAt: opts.createdAt ?? 1,
  });
}

/** Register an order on a deal leg and set its venue state/cum. */
export function order(store: Store, dealId: string, legName: 'A' | 'B', qty: string, cum: string, state: 'OPEN' | 'CLOSED' | 'DEAD' = 'CLOSED'): number {
  const pair = store.getPair(dealId)!;
  const side = legName === 'A' ? pair.a.side : pair.b!.side;
  const o = store.insertPendingOrder({ pairId: dealId, leg: legName, kind: 'taker', side, qty, price: null, tif: 'ioc', now: 1 });
  store.updateOrder(dealId, legName, o.seq, { state, cumQty: cum, avgFillPrice: cum === '0' ? '0' : '2500' });
  return o.seq;
}

export function setCum(store: Store, dealId: string, legName: 'A' | 'B', seq: number, cum: string, state?: 'OPEN' | 'CLOSED'): void {
  store.updateOrder(dealId, legName, seq, { cumQty: cum, ...(state ? { state } : {}) });
}

/** A two-leg funding slice: long LONG_C, short SHORT_C. */
export function twoLegSlice(store: Store, id: string, observed: Record<string, string> = {}): void {
  store.slices.create({
    id,
    kind: 'funding-two-leg',
    source: { test: id },
    legs: [{ leg: 'long', contract: LONG_C, side: 'long' }, { leg: 'short', contract: SHORT_C, side: 'short' }],
    observed: { [LONG_C]: '0', [SHORT_C]: '0', ...observed },
    now: 10,
  });
}
