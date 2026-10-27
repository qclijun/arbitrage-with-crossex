import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FundingHistoryCache } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher, type FundingHistorySource } from '../../src/core/funding/history-collector';
import { BTC, D, H, M, T, leg, pair, run, setup, stubSource } from '../helpers/funding-history-stub';

beforeEach(() => {
  vi.useFakeTimers({ now: T + M });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('funding history refresher', () => {
  it('stops only a rate-limited venue, without retrying into it; other venues publish normally', async () => {
    // Both Bybit workers are already in flight when the first 429 lands; neither retries.
    const legs = [BTC.binance, leg('BINANCE', 'ETHUSDT'), BTC.bybit, leg('BYBIT', 'ETHUSDT')];
    const { cache, bybit, refresher } = setup({ legs, bybit: { fail: () => 'rate-limited' } });
    const report = await run(refresher);
    expect(report).toMatchObject({ outcome: 'published', venues: {
      BINANCE: { requests: 10, legs: 2, refreshed: 2, stopped: null },
      BYBIT: { requests: 2, legs: 2, refreshed: 0, stopped: 'rate-limited' },
    } });
    expect(bybit.calls).toHaveLength(2);
    const sameVenue = cache.evaluate({ underlying: 'BTC', short: BTC.binance, long: leg('BINANCE', 'ETHUSDT'), days: 30 }, Date.now())!;
    expect(sameVenue).toMatchObject({ coverage: 'complete', historyEligible: true });
    const crossVenue = cache.evaluate(pair(), Date.now())!;
    expect(crossVenue).toMatchObject({ coverage: 'unknown', historyEligible: false });
    expect(crossVenue.long.lastAttempt).toMatchObject({ outcome: 'error', reason: 'rate-limited' });
  });

  it('spends the request budget newest window first and says what it could not cover', async () => {
    const legs = [BTC.binance, leg('BINANCE', 'ETHUSDT'), leg('BINANCE', 'SOLUSDT')];
    const { cache, binance, refresher } = setup({ legs, budget: { venueRequests: 7, venueConcurrency: 1 } });
    const report = await run(refresher);
    expect(report.venues.BINANCE).toMatchObject({ requests: 7, refreshed: 1, stopped: 'budget-exhausted' });
    expect(binance.calls).toHaveLength(7);
    const eth = { underlying: 'BTC', short: BTC.binance, long: leg('BINANCE', 'ETHUSDT') };
    expect(cache.evaluate({ ...eth, days: 30 }, Date.now())).toMatchObject({ coverage: 'complete', historyEligible: true });
    const ninety = cache.evaluate({ ...eth, days: 90 }, Date.now())!;
    expect(ninety).toMatchObject({ coverage: 'unknown', historyEligible: false });
    expect(ninety.long.reasons).toContain('page-incomplete');
    expect(ninety.long.lastAttempt).toMatchObject({ reason: 'budget-exhausted' });
    const sol = cache.evaluate({ ...eth, long: leg('BINANCE', 'SOLUSDT'), days: 7 }, Date.now())!;
    expect(sol).toMatchObject({ coverage: 'unknown', historyEligible: false });
    expect(sol.long.lastAttempt).toMatchObject({ reason: 'budget-exhausted' });

    // The next round starts with the legs verified least recently.
    binance.calls.length = 0;
    await run(refresher);
    expect(binance.calls[0]).toMatch(/^SOLUSDT:/);
  });

  it('caps per-venue concurrency, times out hung reads and retries once', async () => {
    const legs = ['A', 'B', 'C', 'D'].map((c) => leg('BINANCE', c));
    const ok = setup({ legs });
    await run(ok.refresher);
    expect(ok.binance.peak()).toBe(2);

    const hung = setup({ legs: [BTC.binance, leg('BINANCE', 'ETHUSDT')], binance: { fail: () => 'hang' },
      budget: { deadlineMs: 8_000, venueConcurrency: 1 } });
    const report = await run(hung.refresher);
    // 5 s timeout, 250 ms jitter, one retry that times out again; then past the 8 s deadline.
    expect(hung.binance.calls).toHaveLength(2);
    expect(report.venues.BINANCE).toMatchObject({ requests: 2, stopped: 'deadline' });
    expect(report.finishedAt - report.startedAt).toBeLessThanOrEqual(10_250);
    const result = hung.cache.evaluate({ underlying: 'BTC', short: BTC.binance, long: leg('BINANCE', 'ETHUSDT'), days: 7 }, Date.now())!;
    expect(result.short.lastAttempt).toMatchObject({ reason: 'timeout' });
    expect(result.long.lastAttempt).toMatchObject({ reason: 'deadline' });
  });

  it('explains a cold start: failed contract list, missing source and unproven cadence', async () => {
    const cache = new FundingHistoryCache();
    const binance = stubSource('BINANCE');
    const failing = createFundingHistoryRefresher({ cache, sources: [binance.source],
      legs: async () => { throw new Error('rules down'); } });
    expect(await run(failing)).toMatchObject({ outcome: 'failed', reason: 'leg-list-failed' });
    expect(cache.view(Date.now())).toMatchObject({ state: 'cold', lastRound: { outcome: 'failed', reason: 'leg-list-failed' } });

    const throwing = stubSource('BYBIT');
    throwing.source.page = async () => { throw new Error('adapter bug outside call'); };
    binance.source.context = async () => null;
    const gate = { venue: 'GATE', contractId: 'BTC_USDT' };
    const refresher = createFundingHistoryRefresher({ cache, sources: [binance.source, throwing.source],
      legs: async () => [BTC.binance, gate, BTC.bybit] });
    expect(await run(refresher)).toMatchObject({ outcome: 'published' });
    expect(cache.evaluate(pair(7), Date.now())!.long.lastAttempt).toMatchObject({ reason: 'source-error' });
    expect(binance.calls).toHaveLength(0);
    const result = cache.evaluate({ underlying: 'BTC', short: BTC.binance, long: gate, days: 7 }, Date.now())!;
    expect(result).toMatchObject({ coverage: 'unknown', historyEligible: false, netTotal: null });
    expect(result.short.lastAttempt).toMatchObject({ outcome: 'error', reason: 'schedule-unverified' });
    expect(result.short.reasons).toContain('schedule-unverified');
    expect(result.long.lastAttempt).toMatchObject({ outcome: 'error', reason: 'no-history-source' });
    expect(result.long.source).toMatchObject({ status: 'unknown', reason: 'no-history-source' });
  });

  it('publishes a fresh partial leg when the venue misses a settlement, and pages through cursors', async () => {
    const { cache, binance, refresher } = setup({ binance: { pageSize: 10 }, bybit: { drop: T - 2 * H } });
    await run(refresher);
    // 21 settlements in 7 days (first at 16:00) at 10 a page: three pages for the first segment.
    expect(binance.calls.slice(0, 3)).toEqual([`BTCUSDT:${T - 7 * D}:`, `BTCUSDT:${T - 7 * D}:${T - 7 * D + 78 * H}`,
      `BTCUSDT:${T - 7 * D}:${T - 7 * D + 158 * H}`]);
    const result = cache.evaluate(pair(7), Date.now())!;
    expect(result.short).toMatchObject({ coverage: 'complete', fresh: true, total: '0.0021' });
    expect(result.long).toMatchObject({ coverage: 'partial', fresh: true, missingEvents: [T - 2 * H], total: null });
    expect(result).toMatchObject({ coverage: 'partial', historyEligible: false, netTotal: null });
  });

  it('shares one global request budget across venues', async () => {
    const { refresher } = setup({ budget: { globalRequests: 6 } });
    const report = await run(refresher);
    expect(report.requests).toBe(6);
    expect(Object.values(report.venues).map((v) => v.stopped)).toContain('budget-exhausted');
  });

  it('runs every ten minutes plus one minute, never two rounds at once, until stopped', async () => {
    vi.setSystemTime(T + 3 * M);
    const { cache, binance, refresher } = setup();
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.view(Date.now()).state).toBe('ready');
    const rounds = () => binance.calls.filter((c) => c.endsWith(`:${T - 7 * D}:`)).length;
    expect(rounds()).toBe(1);
    await vi.advanceTimersByTimeAsync(8 * M - 1);
    expect(rounds()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rounds()).toBe(2);
    expect(cache.view(Date.now()).lastRound!.startedAt).toBe(T + 11 * M);
    refresher.stop();
    await vi.advanceTimersByTimeAsync(H);
    expect(rounds()).toBe(2);
  });

  it('keeps a leg re-read every round fresh between publishes, not only at them', async () => {
    // Three Binance legs on two workers: the first two are verified well before the round publishes.
    const legs = [BTC.binance, leg('BINANCE', 'ETHUSDT'), leg('BINANCE', 'SOLUSDT'), BTC.bybit];
    const { cache, refresher } = setup({ legs, binance: { delayMs: 4_000 }, bybit: { delayMs: 4_000 } });
    refresher.start();
    await vi.advanceTimersByTimeAsync(3 * M);
    const stale: number[] = [];
    while (Date.now() < T + H - 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      for (const short of legs.slice(0, 3)) {
        if (!cache.evaluate({ underlying: 'BTC', short, long: BTC.bybit, days: 7 }, Date.now())!.fresh) stale.push(Date.now());
      }
    }
    refresher.stop();
    expect(stale).toEqual([]);
  });

  it('counts Hyperliquid rows stamped off the hour only through a proven settlement-hour mapping', async () => {
    const hl = (mapped: boolean): FundingHistorySource => ({
      venue: 'HYPERLIQUID', api: 'info:fundingHistory', version: 'stub-v1', maxDays: 7,
      context: async () => ({ listing: { at: 0, evidence: 'hl/listing' },
        rules: [{ from: 0, until: T + D, everyHours: 1, anchor: 0, evidence: 'hl/hourly' }] }),
      page: (coin, range, _cursor, call) => call(`HL ${coin} ${range.start}`, async () => {
        const rows = [];
        for (let t = range.start + H; t <= range.end; t += H) rows.push({ coin, time: t + 76, fundingRate: '0.00001' });
        return { rows, rawHash: 'hl', firstAt: range.start + H + 76, lastAt: range.end + 76, cursor: null, done: true };
      }),
      ...(mapped ? { timeMapping: (row: Record<string, unknown>) => ({
        settlementAt: Math.floor(Number(row.time) / H) * H, evidence: 'hl/time-mapping' }) } : {}),
    });
    const key = { venue: 'HYPERLIQUID', contractId: 'BTC' };
    const hlPair = { underlying: 'BTC', short: key, long: BTC.binance, days: 7 as const };
    for (const mapped of [true, false]) {
      const cache = new FundingHistoryCache();
      const binance = stubSource('BINANCE');
      await run(createFundingHistoryRefresher({ cache, sources: [hl(mapped), binance.source], legs: async () => [key, BTC.binance] }));
      const result = cache.evaluate(hlPair, Date.now())!;
      if (mapped) expect(result.short).toMatchObject({ coverage: 'complete', total: '0.00168' });
      else expect(result.short).toMatchObject({ coverage: 'unknown', lastAttempt: { reason: 'settlement-unnormalized' } });
    }
  });

  it('holds a settlement the venue revised between rounds as a conflict instead of overwriting it', async () => {
    const { cache, bybit, refresher } = setup();
    await run(refresher);
    const page = bybit.source.page;
    bybit.source.page = async (...args) => {
      const result = await page(...args);
      return { ...result, rows: result.rows.map((row) =>
        (Number(row.fundingRateTimestamp) === T - 2 * H ? { ...row, fundingRate: '0.0005' } : row)) };
    };
    vi.setSystemTime(T + 5 * M);
    await run(refresher);
    const result = cache.evaluate(pair(7), Date.now())!;
    expect(result.long).toMatchObject({ coverage: 'unknown', fresh: true, total: null });
    expect(result.long.conflicts).toMatchObject([{ settledAt: T - 2 * H,
      variants: [{ rate: '0.0005' }, { rate: '-0.0001' }] }]);
    expect(result.historyEligible).toBe(false);
  });

  it('bounds a hung contract list and adapter work outside the budgeted call', async () => {
    const cache = new FundingHistoryCache();
    const binance = stubSource('BINANCE');
    let hangList = true;
    const refresher = createFundingHistoryRefresher({ cache, sources: [binance.source],
      legs: () => (hangList ? new Promise(() => undefined) : Promise.resolve([BTC.binance])) });
    expect(await run(refresher)).toMatchObject({ outcome: 'failed', reason: 'leg-list-failed' });
    expect(cache.view(Date.now()).refreshing).toBe(false);

    hangList = false;
    binance.source.context = () => new Promise(() => undefined);
    const report = await run(refresher);
    expect(report).toMatchObject({ outcome: 'published' });
    // 4-minute deadline plus one request's worst case: two 5 s attempts and a 1 s jitter.
    expect(report.finishedAt - report.startedAt).toBeLessThanOrEqual(4 * M + 11_000);
    expect(cache.evaluate({ underlying: 'BTC', short: BTC.binance, long: BTC.binance, days: 7 }, Date.now())!.short.lastAttempt)
      .toMatchObject({ reason: 'deadline' });
  });
});
