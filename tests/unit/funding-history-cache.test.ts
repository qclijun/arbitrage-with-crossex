import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FundingHistoryCache } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher } from '../../src/core/funding/history-collector';
import { BTC, H, M, T, pair, run, setup, stubSource } from '../helpers/funding-history-stub';

beforeEach(() => {
  vi.useFakeTimers({ now: T + M });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('funding history cache reads', () => {
  it('starts cold, then publishes one common-cutoff snapshot that the server recheck admits', async () => {
    const cache = new FundingHistoryCache();
    expect(cache.view(Date.now())).toMatchObject({ state: 'cold', refreshing: false, lastRound: null });
    expect(cache.evaluate(pair(), Date.now())).toBeNull();
    expect(cache.recheck({ snapshotId: 'any', ...pair() }, Date.now())).toMatchObject({ admitted: false, reason: 'history-cold-start' });

    const binance = stubSource('BINANCE');
    const bybit = stubSource('BYBIT');
    const refresher = createFundingHistoryRefresher({
      cache,
      sources: [binance.source, bybit.source],
      legs: async () => [BTC.binance, BTC.bybit],
    });
    const report = await refresher.runOnce();
    expect(report).toMatchObject({ outcome: 'published', cutoff: T });

    const view = cache.view(Date.now());
    expect(view).toMatchObject({ state: 'ready', cutoff: T, cutoffBehind: false, refreshing: false });
    const result = cache.evaluate(pair(), Date.now())!;
    expect(result).toMatchObject({ cutoff: T, coverage: 'complete', fresh: true, historyEligible: true });
    // 30 days of 8-hour settlements: 90 × 0.0001 short minus 90 × -0.0001 long.
    expect(result.netTotal).toBe('0.018');
    expect(cache.evaluate(pair(365), Date.now())!.historyEligible).toBe(true);
    expect(cache.recheck({ snapshotId: view.snapshotId!, ...pair() }, Date.now())).toMatchObject({ admitted: true });
  });

  it('expires 15 minutes after the last success; a failed refresh keeps the old time and does not extend it', async () => {
    let failing = false;
    const fail = () => (failing ? 'error' as const : null);
    const { cache, refresher } = setup({ binance: { fail }, bybit: { fail } });
    await run(refresher);
    const verifiedAt = cache.evaluate(pair(), Date.now())!.short.verifiedAt!;
    const snapshotId = cache.view(Date.now()).snapshotId!;

    vi.setSystemTime(T + 10 * M);
    failing = true;
    await run(refresher);
    const retried = cache.evaluate(pair(), verifiedAt + 15 * M)!;
    expect(retried.short).toMatchObject({ verifiedAt, coverage: 'complete', fresh: true });
    expect(retried.short.lastAttempt).toMatchObject({ outcome: 'error', reason: 'error' });
    expect(retried.short.lastAttempt!.at).toBeGreaterThan(verifiedAt);

    const late = cache.evaluate(pair(), verifiedAt + 15 * M + 1)!;
    expect(late).toMatchObject({ coverage: 'complete', fresh: false, historyEligible: false });
    expect(late.short.verifiedAt).toBe(verifiedAt);
    const current = cache.view(Date.now()).snapshotId!;
    expect(current).not.toBe(snapshotId);
    expect(cache.recheck({ snapshotId: current, ...pair() }, verifiedAt + 15 * M + 1))
      .toMatchObject({ admitted: false, reason: 'history-ineligible' });
  });

  it('goes stale across a UTC hour even one minute after verification', async () => {
    vi.setSystemTime(T + 59 * M);
    const { cache, refresher } = setup();
    await run(refresher);
    const snapshotId = cache.view(Date.now()).snapshotId!;
    expect(cache.recheck({ snapshotId, ...pair() }, Date.now())).toMatchObject({ admitted: true });

    const now = T + H + 30_000;
    expect(cache.view(now)).toMatchObject({ state: 'ready', cutoff: T, cutoffBehind: true });
    expect(cache.evaluate(pair(), now)).toMatchObject({ cutoff: T, coverage: 'complete', fresh: false, historyEligible: false });
    expect(cache.recheck({ snapshotId, ...pair() }, now)).toMatchObject({ admitted: false, reason: 'history-cutoff-behind' });
  });

  it('serves the last published snapshot while a round is in flight; reads never call a source', async () => {
    let hold = false;
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const binance = stubSource('BINANCE');
    const page = binance.source.page;
    binance.source.page = async (...args) => {
      if (hold) await gate;
      return page(...args);
    };
    const bybit = stubSource('BYBIT');
    const cache = new FundingHistoryCache();
    const refresher = createFundingHistoryRefresher({ cache, sources: [binance.source, bybit.source],
      legs: async () => [BTC.binance, BTC.bybit], random: () => 0 });

    hold = true;
    const first = refresher.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.view(Date.now())).toMatchObject({ state: 'cold', refreshing: true });
    expect(cache.evaluate(pair(), Date.now())).toBeNull();
    release();
    await first;
    const published = cache.view(Date.now()).snapshotId;

    // A second round stalls half way: Bybit has new evidence, Binance not yet.
    hold = true;
    let releaseAgain = () => undefined as void;
    const gateAgain = new Promise<void>((resolve) => { releaseAgain = resolve; });
    binance.source.page = async (...args) => {
      await gateAgain;
      return page(...args);
    };
    vi.setSystemTime(T + 5 * M);
    const second = refresher.runOnce();
    expect(refresher.runOnce()).toBe(second);
    await vi.advanceTimersByTimeAsync(0);
    const calls = binance.calls.length + bybit.calls.length;
    const view = cache.view(Date.now());
    expect(view).toMatchObject({ state: 'ready', snapshotId: published, refreshing: true });
    expect(cache.evaluate(pair(), Date.now())!.long.verifiedAt).toBe(T + M);
    cache.recheck({ snapshotId: published!, ...pair() }, Date.now());
    expect(binance.calls.length + bybit.calls.length).toBe(calls);
    releaseAgain();
    await second;
    expect(cache.view(Date.now()).snapshotId).not.toBe(published);
    expect(cache.evaluate(pair(), Date.now())!.long.verifiedAt).toBeGreaterThanOrEqual(T + 5 * M);
  });

  it('never splices legs from different cutoffs, and keeps wider old evidence over a narrower re-read', async () => {
    let binanceFail: (n: number) => boolean = () => false;
    let bybitFails = false;
    let binanceCalls = 0;
    const { cache, refresher } = setup({
      binance: { fail: () => (binanceFail(binanceCalls++) ? 'error' : null) },
      bybit: { fail: () => (bybitFails ? 'error' : null) },
    });
    await run(refresher);

    // Same cutoff: Binance re-reads only the 7-day segment before failing; its full year stays.
    vi.setSystemTime(T + 5 * M);
    const start = binanceCalls;
    binanceFail = (n) => n > start;
    await run(refresher);
    const kept = cache.evaluate(pair(365), Date.now())!;
    expect(kept.short).toMatchObject({ coverage: 'complete', verifiedAt: T + M, lastAttempt: { outcome: 'error', reason: 'error' } });

    // Next hour both venues fail: the legs share the old cutoff, readable as complete but stale.
    vi.setSystemTime(T + H + M);
    binanceFail = () => true;
    bybitFails = true;
    await run(refresher);
    const old = cache.evaluate(pair(), Date.now())!;
    expect(old).toMatchObject({ cutoff: T, coverage: 'complete', fresh: false, historyEligible: false });
    const snapshotId = cache.view(Date.now()).snapshotId!;
    expect(cache.view(Date.now()).cutoff).toBe(T + H);
    expect(cache.recheck({ snapshotId, ...pair() }, Date.now())).toMatchObject({ admitted: false, reason: 'history-ineligible' });

    // Binance recovers, Bybit does not: evaluated at the new cutoff, never spliced with Bybit's old one.
    vi.setSystemTime(T + 2 * H + M);
    binanceFail = () => false;
    await run(refresher);
    const split = cache.evaluate(pair(), Date.now())!;
    expect(split).toMatchObject({ cutoff: T + 2 * H, coverage: 'unknown', historyEligible: false, netTotal: null });
    expect(split.short).toMatchObject({ coverage: 'complete', fresh: true });
    expect(split.long).toMatchObject({ verifiedAt: T + 5 * M, lastAttempt: { outcome: 'error' } });
  });


  it('keeps short windows fresh on a narrower re-read while the wider old read still serves long ones', async () => {
    let binanceCalls = 0;
    let failAfter = Infinity;
    const { cache, refresher } = setup({ binance: { fail: () => (binanceCalls++ > failAfter ? 'error' : null) } });
    await run(refresher);

    // Same cutoff: Binance re-reads only its 7-day segment, then fails.
    vi.setSystemTime(T + 5 * M);
    failAfter = binanceCalls;
    await run(refresher);
    const reread = cache.evaluate(pair(7), Date.now())!.short;
    expect(reread).toMatchObject({ coverage: 'complete', fresh: true, lastAttempt: { outcome: 'error', reason: 'error' } });
    expect(reread.verifiedAt).toBeGreaterThanOrEqual(T + 5 * M);
    expect(cache.evaluate(pair(365), Date.now())!.short).toMatchObject({ coverage: 'complete', fresh: true, verifiedAt: T + M });

    // Past the full read's 15 minutes: only the windows the re-read proved stay fresh.
    const later = T + 16 * M + 1;
    expect(cache.evaluate(pair(7), later)).toMatchObject({ coverage: 'complete', fresh: true, historyEligible: true });
    expect(cache.evaluate(pair(30), later)).toMatchObject({ coverage: 'complete', fresh: false, historyEligible: false });
    const snapshotId = cache.view(later).snapshotId!;
    expect(cache.recheck({ snapshotId, ...pair(7) }, later)).toMatchObject({ admitted: true });
  });

  it('rejects a preview bound to a superseded snapshot even when the new one is eligible', async () => {
    const { cache, refresher } = setup();
    await run(refresher);
    const previewed = cache.view(Date.now()).snapshotId!;
    vi.setSystemTime(T + 5 * M);
    await run(refresher);
    const current = cache.view(Date.now()).snapshotId!;
    expect(cache.recheck({ snapshotId: previewed, ...pair() }, Date.now())).toMatchObject({ admitted: false, reason: 'history-snapshot-superseded' });
    expect(cache.recheck({ snapshotId: current, ...pair() }, Date.now())).toMatchObject({ admitted: true });
    expect(cache.recheck({ snapshotId: current, ...pair(), long: { venue: 'BYBIT', contractId: 'ETHUSDT' } }, Date.now()))
      .toMatchObject({ admitted: false, reason: 'history-leg-missing' });
  });
});
