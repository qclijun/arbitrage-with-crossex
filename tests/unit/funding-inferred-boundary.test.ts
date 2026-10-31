import { afterEach, expect, it, vi } from 'vitest';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { createFundingHistoryRefresher } from '../../src/core/funding/history-collector';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import { CUTOFF, H } from '../helpers/funding-ranking-fixture';
import { run } from '../helpers/funding-history-stub';

afterEach(() => vi.useRealTimers());

it('keeps the cutoff settlement and excludes the start settlement when both have processing jitter', async () => {
  vi.useFakeTimers({ now: CUTOFF + 60_000 });
  const key = { venue: 'BINANCE', contractId: 'BTCUSDT' };
  const source = createOfficialHistorySources({ context: () => ({ listing: null, rules: [] }), read: async (_venue, rawUrl) => {
    const query = new URL(rawUrl).searchParams;
    const start = Number(query.get('startTime'));
    const end = Number(query.get('endTime'));
    expect(end).toBe(CUTOFF + 999);
    const rows = [];
    for (let time = Math.floor(start / (8 * H)) * 8 * H; time <= end; time += 8 * H) {
      if (time + 2 >= start && time + 2 <= end) rows.push({ symbol: key.contractId, fundingTime: time + 2, fundingRate: '0.0001' });
    }
    return rows;
  } }).find((s) => s.venue === 'BINANCE')!;
  const cache = new FundingHistoryCache();
  const refresher = createFundingHistoryRefresher({ cache, sources: [{ ...source, maxDays: 7 }], legs: async () => [key], inferCadence: true });
  const report = await run(refresher);
  expect(report.requests).toBe(1);
  expect(cache.evaluate({ short: key, long: key, underlying: 'BTC', days: 7 }, Date.now()))
    .toMatchObject({ coverage: 'complete', historyEligible: true, short: { observed: { events: 21, lastAt: CUTOFF } } });
  const events = cache.snapshot()!.legs.get(legKey(key))!.leg.events;
  expect(events[0]!.settledAt).toBe(CUTOFF - 7 * 24 * H + 8 * H);
  expect(events.at(-1)).toMatchObject({ settledAt: CUTOFF, rawTime: CUTOFF + 2 });
});
