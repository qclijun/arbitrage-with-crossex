/**
 * Deal-creation seam (`resolveDeal`): the maker-pair deadline.
 *
 * A maker PAIR bounds its unhedged time; a single maker leg rests forever. The
 * four-leg workflow's perpetual hedge deal is marked by its quote mode — the
 * `'best'` value ticket 01 introduces — and waits thirty minutes by default.
 * An ordinary perpetual pair keeps the five-minute default and the existing
 * `[30, 3600]` clamp, which is NOT this ticket's to move.
 *
 * Only the rule lookup is exercised: the fixture legs have a zero min-notional
 * (so no reference-price check runs) and the margin preflight fails open on a
 * leg it cannot price.
 */
import { describe, expect, it } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { resolveDeal, type DealRequest } from '../../src/engine/create';
import { A_CONTRACT, B_CONTRACT } from './engine-sim';

// camelCase: the SDK deserializes Gate's snake_case, so this stub — which stands
// in for `listCrossexRuleSymbols` — speaks the shape `resolveDeal` already sees.
function ruleRow(symbol: string) {
  return {
    symbol,
    state: 'live',
    businessType: 'FUTURE',
    lotSize: '0.001',
    minSize: '0',
    minNotional: '0',
    tickSize: '0.01',
    maxMarketSize: '10000',
    maxLimitSize: '10000',
  };
}

const clients = {
  crossEx: { listCrossexRuleSymbols: async () => ({ body: [ruleRow(A_CONTRACT), ruleRow(B_CONTRACT)] }) },
} as unknown as Clients;

const NOW = 1_700_000_000_000;

/** A maker pair: leg A rests POC, leg B hedges at market. */
const makerPair = (over?: Partial<DealRequest>): DealRequest => ({
  id: 'deal-000001',
  a: { symbol: A_CONTRACT, side: 'BUY' },
  b: { symbol: B_CONTRACT, side: 'SELL' },
  qty: '0.152',
  execution: 'maker',
  price: '2500',
  ...over,
});

describe('maker-pair deadline default', () => {
  it.each([
    { pricePolicy: 'touch' }, { execution: 'taker' }, { b: null },
    { a: { symbol: A_CONTRACT, side: 'BUY', reduceOnly: true } },
    { b: { symbol: B_CONTRACT, side: 'SELL', reduceOnly: true } },
  ] as Partial<DealRequest>[])('rejects an inapplicable automatic policy on a pinned request: %j', async (over) => {
    await expect(resolveDeal(clients, makerPair({ pricePolicy: 'fixed', autoPricePolicy: 'best', ...over }), NOW))
      .rejects.toThrow('autoPricePolicy is only supported');
  });

  it('preserves an initially pinned four-leg price and its automatic policy', async () => {
    const row = await resolveDeal(clients, makerPair({ pricePolicy: 'fixed', autoPricePolicy: 'best', price: '2480' }), NOW);
    expect(row.pricePolicy).toBe('fixed');
    expect(row.autoPricePolicy).toBe('best');
    expect(row.limitPrice).toBe('2480');
    expect(row.deadlineAt).toBe(NOW + 30 * 60 * 1000);
  });

  it('waits thirty minutes for a four-leg deal (quote mode "best")', async () => {
    const row = await resolveDeal(clients, makerPair({ pricePolicy: 'best' }), NOW);
    expect(row.deadlineAt).toBe(NOW + 30 * 60 * 1000);
  });

  it('keeps the five-minute default for an ordinary perpetual pair', async () => {
    const row = await resolveDeal(clients, makerPair({ pricePolicy: 'touch' }), NOW);
    expect(row.deadlineAt).toBe(NOW + 5 * 60 * 1000);
  });

  it('honours an explicit window for a four-leg deal — the wait stays adjustable', async () => {
    const row = await resolveDeal(clients, makerPair({ pricePolicy: 'best', timeoutSec: 60 }), NOW);
    expect(row.deadlineAt).toBe(NOW + 60 * 1000);
  });

  it('leaves the existing clamp exactly as it was (30s floor, 60m ceiling)', async () => {
    const low = await resolveDeal(clients, makerPair({ pricePolicy: 'best', timeoutSec: 1 }), NOW);
    expect(low.deadlineAt).toBe(NOW + 30 * 1000);
    const high = await resolveDeal(clients, makerPair({ pricePolicy: 'best', timeoutSec: 99_999 }), NOW);
    expect(high.deadlineAt).toBe(NOW + 3_600 * 1000);
    // 30 minutes sits inside the window untouched — no constant other than the
    // flow default may move.
    const mid = await resolveDeal(clients, makerPair({ timeoutSec: 1_800 }), NOW);
    expect(mid.deadlineAt).toBe(NOW + 30 * 60 * 1000);
  });

  it('gives a single maker leg no deadline at all, whatever the quote mode', async () => {
    const row = await resolveDeal(clients, makerPair({ b: null, pricePolicy: 'best' }), NOW);
    expect(row.deadlineAt).toBeNull();
  });
});
