import { afterEach, expect, it, vi } from 'vitest';
import { FundingHistoryCache } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher, type FundingHistorySource } from '../../src/core/funding/history-collector';
import { D, H, T, run } from '../helpers/funding-history-stub';

afterEach(() => vi.useRealTimers());

it('re-estimates cadence across refreshes without confusing derived intervals with revised rates', async () => {
  vi.useFakeTimers({ now: T + 60_000 });
  let changed = false;
  let fail = false;
  let revised = false;
  const pivot = Math.floor((T - D) / (8 * H)) * 8 * H;
  const key = { venue: 'BINANCE', contractId: 'BTCUSDT' };
  const cache = new FundingHistoryCache();
  const source: FundingHistorySource = {
    ...key, api: '/fapi/v1/fundingRate', version: 'fixture', maxDays: 7,
    context: async () => ({ listing: null, rules: [], ...(fail ? { proofRejected: 'historical-policy-changed' as const } : {}) }),
    page: (_id, range, _cursor, call) => call('fixture settled history', async () => {
      if (fail) throw new Error('fixture outage');
      const rows = [];
      for (let time = Math.ceil((range.start + 1) / (4 * H)) * 4 * H; time <= range.end; time += 4 * H) {
        if ((!changed || time <= pivot) && time % (8 * H) !== 0) continue;
        rows.push({ symbol: key.contractId, fundingTime: time, fundingRate: revised && time === pivot ? '0.99' : '0.0001' });
      }
      return { rows, rawHash: 'fixture', firstAt: rows[0]!.fundingTime, lastAt: rows.at(-1)!.fundingTime, cursor: null, done: true };
    }),
  };
  const refresher = createFundingHistoryRefresher({ cache, sources: [source], legs: async () => [key], inferCadence: true });
  const evaluate = () => cache.evaluate({ short: key, long: key, underlying: 'BTC', days: 7 }, Date.now());
  await run(refresher);
  expect(evaluate()).toMatchObject({ coverage: 'complete', short: { cadence: { intervals: [8] } } });
  changed = true;
  await run(refresher);
  expect(evaluate()).toMatchObject({ coverage: 'complete', short: { cadence: { intervals: [8, 4] }, conflicts: [] } });
  const verifiedAt = evaluate()!.short.verifiedAt;
  fail = true;
  await run(refresher);
  expect(evaluate()).toMatchObject({ coverage: 'complete', short: { verifiedAt, cadence: { basis: 'inferred' },
    source: { reason: 'historical-policy-changed' } } });
  fail = false; revised = true;
  await run(refresher);
  expect(evaluate()).toMatchObject({ coverage: 'unknown', historyEligible: false,
    short: { conflicts: [expect.objectContaining({ settledAt: pivot })] } });
});
