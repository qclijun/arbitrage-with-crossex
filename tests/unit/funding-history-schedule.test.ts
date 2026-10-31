import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher } from '../../src/core/funding/history-collector';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { BTC, D, H, M, T, currentFor, grid, pair, run, setup, stubSource } from '../helpers/funding-history-stub';

beforeEach(() => {
  vi.useFakeTimers({ now: T + M });
});
afterEach(() => {
  vi.useRealTimers();
});

const binanceOnly = (days: 7 | 30 | 90 | 365) => ({ underlying: 'BTC', short: BTC.binance, long: BTC.binance, days });
const termination = (cache: FundingHistoryCache) => cache.snapshot()!.legs.get(legKey(BTC.binance))!.leg.pages.termination;

describe('funding history cadence double proof', () => {
  it('reads nothing when the current interval quote is stale', async () => {
    const cache = new FundingHistoryCache();
    const binance = stubSource('BINANCE');
    const stale = () => new Map([[legKey(BTC.binance), { intervalHours: 8, at: Date.now() - 15 * M - 1 }]]);
    await run(createFundingHistoryRefresher({ cache, sources: [binance.source], legs: async () => [BTC.binance],
      currentSchedules: stale }));
    expect(binance.calls).toHaveLength(0);
    expect(cache.evaluate(binanceOnly(7), Date.now())!.short).toMatchObject({ coverage: 'unknown',
      lastAttempt: { reason: 'schedule-unverified' } });
  });

  it('stays stable across rounds: an interval flicker is UNKNOWN for its round and leaves no conflict behind', async () => {
    const hours: Record<string, number> = { BINANCE: 8, BYBIT: 8 };
    const { cache, refresher } = setup({ current: hours });
    await run(refresher);
    expect(cache.evaluate(pair(30), Date.now())).toMatchObject({ coverage: 'complete', historyEligible: true });

    vi.setSystemTime(T + 5 * M);
    hours.BINANCE = 4;
    await run(refresher);
    const flicker = cache.evaluate(pair(30), Date.now())!;
    expect(flicker.short).toMatchObject({ coverage: 'unknown', lastAttempt: { reason: 'schedule-unverified' } });
    expect(termination(cache)).toBe('all-segments-done;schedule:run-too-short');

    vi.setSystemTime(T + 9 * M);
    hours.BINANCE = 8;
    await run(refresher);
    for (const days of [7, 30, 90, 365] as const) {
      const result = cache.evaluate(pair(days), Date.now())!;
      expect(result).toMatchObject({ coverage: 'complete', historyEligible: true });
      expect(result.short.conflicts).toEqual([]);
    }
  });

  it('proves only the trailing run after a real 8h to 4h change, round after round', async () => {
    const switchAt = T - 10 * D - 2 * H;
    const times = () => [...grid(8, T - 366 * D, switchAt - 1), ...grid(4, switchAt - 1, T)];
    const { cache, refresher } = setup({ binance: { times }, current: { BINANCE: 4, BYBIT: 8 } });
    for (const at of [T + M, T + 5 * M]) {
      vi.setSystemTime(at);
      await run(refresher);
      // Seven days of 4-hour settlements at 0.0001.
      expect(cache.evaluate(pair(7), Date.now())!.short).toMatchObject({ coverage: 'complete', total: '0.0042' });
      for (const days of [30, 90, 365] as const) {
        const short = cache.evaluate(pair(days), Date.now())!.short;
        expect(short.coverage).toBe('unknown');
        expect(short.reasons).toContain('schedule-unverified');
        expect(short.reasons).not.toContain('settlement-conflict');
      }
    }
  });

  it('proves a budget-cut read from its fully read segments only, dropping a half-read segment', async () => {
    // 7 days in one page, the next 23 days in three, then one of six 90-day pages before the budget runs out.
    const { cache, binance, refresher } = setup({ legs: [BTC.binance], binance: { pageSize: 30 }, budget: { venueRequests: 5 } });
    await run(refresher);
    expect(binance.calls).toHaveLength(5);
    expect(termination(cache)).toBe('stopped:budget-exhausted');
    expect(cache.evaluate(binanceOnly(30), Date.now())).toMatchObject({ coverage: 'complete', historyEligible: true });
    expect(cache.evaluate(binanceOnly(90), Date.now())!.short.reasons).toContain('page-incomplete');
  });

  it('proves official Binance history whose fundingTime jitters under a second, including the settlement at the cutoff', async () => {
    const cutoff = T - 2 * H;
    vi.setSystemTime(cutoff + M);
    for (const late of [0, 1_000]) {
      const jitter = (t: number) => (t === cutoff - D ? late : 1 + ((t / (8 * H)) % 15));
      const read = async (_venue: string, url: string) => {
        const query = new URL(url).searchParams;
        const [from, to] = [Number(query.get('startTime')), Number(query.get('endTime'))];
        return grid(8, from - 8 * H, to).map((t) => t + jitter(t)).filter((raw) => raw >= from && raw <= to)
          .map((fundingTime) => ({ symbol: 'BTCUSDT', fundingTime, fundingRate: '0.0001' }));
      };
      const cache = new FundingHistoryCache();
      const [binance] = createOfficialHistorySources({ read, context: async () => ({ listing: { at: 0, evidence: 'listing' } }) });
      await run(createFundingHistoryRefresher({ cache, sources: [binance!], legs: async () => [BTC.binance],
        currentSchedules: currentFor([BTC.binance]) }));
      const week = cache.evaluate(binanceOnly(7), Date.now())!.short;
      if (late) expect(week).toMatchObject({ coverage: 'unknown', reasons: expect.arrayContaining(['schedule-unverified']) });
      else expect(week).toMatchObject({ coverage: 'complete', total: '0.0021', missingEvents: [] });
    }
  });

  it('never ranks a window over a deleted, shifted or re-cadenced record, or under a wrong current interval (seeded fuzz)', async () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
    };
    const tally = { complete: 0, refused: 0, clean: 0 };
    for (let round = 0; round < 120; round += 1) {
      const before = random() < 0.5 ? 8 : 4;
      const switchAt = random() < 0.3 ? T - Math.floor(random() * 120) * D - 2 * H : null;
      const after = switchAt === null ? before : 12 - before;
      const truth = switchAt === null ? grid(after, T - 366 * D, T)
        : [...grid(before, T - 366 * D, switchAt - 1), ...grid(after, switchAt - 1, T)];
      const missing: number[] = [];
      const shifted: number[] = [];
      const duplicated: number[] = [];
      for (let k = Math.floor(random() * 4); k > 0; k -= 1) {
        const t = truth[truth.length - 1 - Math.floor(random() * 600)]!;
        if (missing.includes(t) || duplicated.includes(t)) continue;
        const kind = random();
        if (kind < 0.3) duplicated.push(t);
        else {
          missing.push(t);
          if (kind > 0.6) shifted.push(t + 1_000 + Math.floor(random() * 3 * H));
        }
      }
      const served = [...truth.filter((t) => !missing.includes(t)), ...duplicated, ...shifted];
      const current = random() < 0.8 ? after : 12 - after;
      const cache = new FundingHistoryCache();
      const binance = stubSource('BINANCE', { times: () => served });
      await run(createFundingHistoryRefresher({ cache, sources: [binance.source], legs: async () => [BTC.binance],
        currentSchedules: currentFor([BTC.binance], { BINANCE: current }) }));
      const clean = !missing.length && !shifted.length && switchAt === null && current === after;
      if (clean) tally.clean += 1;
      for (const days of [7, 30, 90, 365] as const) {
        const start = T - days * D;
        const short = cache.evaluate(binanceOnly(days), Date.now())!.short;
        const inWindow = (t: number) => t > start && t <= T;
        if (clean) expect(short.coverage).toBe('complete');
        if (short.coverage !== 'complete') {
          tally.refused += 1;
          continue;
        }
        tally.complete += 1;
        expect(missing.filter(inWindow)).toEqual([]);
        expect(shifted.filter(inWindow)).toEqual([]);
        expect(switchAt === null || switchAt <= start).toBe(true);
        expect(current).toBe(after);
        expect(Number(short.total)).toBeCloseTo(truth.filter(inWindow).length * 0.0001, 10);
      }
    }
    expect(tally.clean).toBeGreaterThan(10);
    expect(tally.complete).toBeGreaterThan(100);
    expect(tally.refused).toBeGreaterThan(100);
  });
});
