import { afterEach, expect, it, vi } from 'vitest';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { normalizeOfficialSettlement, sourceBoundary } from '../../src/core/funding/history-sources';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher, HistoryQuotaWaitError } from '../../src/core/funding/history-collector';
import { run } from '../helpers/funding-history-stub';

const hour = 3_600_000;
const day = 24 * hour;
const cutoff = Date.UTC(2026, 9, 31);
afterEach(() => vi.useRealTimers());

it.each(['ASTER', 'HYPERLIQUID'])('collects %s delayed settlements through the cutoff without external per-row maps', async (venue) => {
  vi.useFakeTimers({ now: cutoff + 60_000 });
  const contractId = venue === 'ASTER' ? 'BTCUSDT' : 'BTC';
  const sources = createOfficialHistorySources({
    context: () => ({ listing: { at: cutoff - 400 * day, evidence: 'fixture listing' },
      rules: [{ from: cutoff - 400 * day, until: cutoff + hour, everyHours: 1, anchor: cutoff, evidence: 'fixture schedule' }] }),
    read: async (_venue, url, _signal, body) => {
      const query = new URL(url).searchParams;
      const start = Number(body ? (body as { startTime: number }).startTime : query.get('startTime'));
      const end = Number(body ? (body as { endTime: number }).endTime : query.get('endTime'));
      return Array.from({ length: 7 * 24 }, (_, i) => cutoff - (167 - i) * hour)
        .map((at) => venue === 'ASTER' ? { symbol: contractId, fundingTime: at + 2, fundingRate: '0.00001' }
          : { coin: contractId, time: at + 76, fundingRate: '0.00001' })
        .filter((r) => Number('time' in r ? r.time : r.fundingTime) >= start
          && Number('time' in r ? r.time : r.fundingTime) <= end);
    },
  });
  const cache = new FundingHistoryCache();
  const key = { venue, contractId };
  const refresher = createFundingHistoryRefresher({ sources, cache, legs: async () => [key],
    budget: { globalRequests: 1, venueRequests: 1 } });
  const report = await run(refresher);
  const leg = cache.snapshot()!.legs.get(legKey(key))!.leg;
  expect(report.requests).toBe(1);
  expect(leg.events).toHaveLength(168);
  expect(leg.events.at(-1)).toMatchObject({ settledAt: cutoff, rawTime: cutoff + (venue === 'ASTER' ? 2 : 76) });
  expect(cache.evaluate({ underlying: 'BTC', short: key, long: key, days: 7 }, Date.now()))
    .toMatchObject({ coverage: 'complete', historyEligible: true });
});

it.each(['ASTER', 'HYPERLIQUID'])('%s rejects delays beyond the calibrated second', (venue) => {
  const source = createOfficialHistorySources().find((s) => s.venue === venue)!;
  const row = venue === 'ASTER' ? { fundingTime: cutoff + 1_000 } : { time: cutoff + 1_000 };
  expect(source.timeMapping?.(row)).toBeUndefined();
  const valid = venue === 'ASTER' ? { symbol: 'BTCUSDT', fundingTime: cutoff + 2, fundingRate: '0.1' }
    : { coin: 'BTC', time: cutoff + 76, fundingRate: '0.1' };
  expect(normalizeOfficialSettlement({ venue, api: source.api, contractId: venue === 'ASTER' ? 'BTCUSDT' : 'BTC' },
    valid, 1, 'fixture page', source.timeMapping?.(valid))).toHaveProperty('rawTime');
});

it('offers OKX archive-backed 180d and 365d history without relaxing the REST retention limit', () => {
  const source = createOfficialHistorySources().find((s) => s.venue === 'OKX')!;
  expect(source.maxDays ?? 365).toBe(365);
  expect(sourceBoundary('OKX', source.api, 180)).toBe('verified');
  expect(sourceBoundary('OKX', source.api, 365)).toBe('verified');
  expect(sourceBoundary('OKX', '/api/v5/public/funding-rate-history', 180)).toBe('unsupported');
});

it('collects actual official settlements when production has no historical schedule', async () => {
  vi.useFakeTimers({ now: cutoff + 60_000 });
  const key = { venue: 'ASTER', contractId: 'BTCUSDT' };
  const sources = createOfficialHistorySources({
    context: () => ({ listing: null, rules: [] }),
    read: async () => [{ symbol: 'BTCUSDT', fundingTime: cutoff + 2, fundingRate: '0.00012345' }],
  });
  const cache = new FundingHistoryCache();
  await run(createFundingHistoryRefresher({ sources, cache, legs: async () => [key],
    budget: { globalRequests: 1, venueRequests: 1 } }));
  const leg = cache.snapshot()!.legs.get(legKey(key))!.leg;
  expect(leg.events).toMatchObject([{ settledAt: cutoff, rate: '0.00012345', intervalHours: null }]);
  expect(leg.lastAttempt?.reason).not.toBe('schedule-unverified');
  expect(cache.evaluate({ underlying: 'BTC', short: key, long: key, days: 7 }, Date.now()))
    .toMatchObject({ coverage: 'unknown', historyEligible: false, short: { total: null,
      observed: { total: '0.00012345', events: 1, firstAt: cutoff, lastAt: cutoff },
      reasons: expect.arrayContaining(['schedule-unverified']) } });
});

it.each([1_000, 60_000])('waits %dms for local quota without stopping the venue or spending a request', async (delay) => {
  vi.useFakeTimers({ now: cutoff + 60_000 });
  let attempts = 0;
  const key = { venue: 'BINANCE', contractId: 'BTCUSDT' };
  const sources = createOfficialHistorySources({ context: () => ({ listing: null, rules: [] }),
    read: async () => {
      attempts += 1;
      if (attempts === 1) throw new HistoryQuotaWaitError(delay);
      return [{ symbol: key.contractId, fundingTime: cutoff, fundingRate: '0.0001' }];
    } });
  const cache = new FundingHistoryCache();
  const report = await run(createFundingHistoryRefresher({ sources, cache, legs: async () => [key],
    budget: { globalRequests: 1, venueRequests: 1, venueConcurrency: 1, maxRetries: 0 } }));
  expect(attempts).toBe(2);
  expect(report).toMatchObject({ requests: 1, venues: { BINANCE: { stopped: 'budget-exhausted' } } });
  expect(cache.snapshot()!.legs.get(legKey(key))!.leg.events).toHaveLength(1);
});

it('does not wait past the round deadline for local quota', async () => {
  vi.useFakeTimers({ now: cutoff + 60_000 });
  const sources = createOfficialHistorySources({ context: () => ({ listing: null, rules: [] }),
    read: async () => { throw new HistoryQuotaWaitError(60_000); } });
  const report = await run(createFundingHistoryRefresher({ sources, cache: new FundingHistoryCache(),
    legs: async () => [{ venue: 'BINANCE', contractId: 'BTCUSDT' }], budget: { deadlineMs: 1_000 } }));
  expect(report).toMatchObject({ requests: 0, venues: { BINANCE: { stopped: 'deadline' } } });
});
