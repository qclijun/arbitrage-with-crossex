import { afterEach, expect, it, vi } from 'vitest';
import { hlBackfillWorld } from '../helpers/funding-hl-backfill-fixture';
import { snapshotCutoff } from '../../src/core/funding/history';
import { D, H, run } from '../helpers/funding-history-stub';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('refreshes both BTC/ETH recent windows before spending the production quota on long history', async () => {
  const w = hlBackfillWorld();
  const report = await run(w.services);
  expect(report.requests).toBeLessThanOrEqual(40);
  expect(w.result('BTC', 7)).toMatchObject({ coverage: 'complete', historyEligible: true });
  expect(w.result('ETH', 7)).toMatchObject({ coverage: 'complete', historyEligible: true });
  expect(w.calls.slice(0, 4).map((c) => c.coin)).toEqual(['BTC', 'BTC', 'ETH', 'ETH']);
});

it('resumes interrupted pages across rounds until both contracts cover all five windows', async () => {
  const w = hlBackfillWorld();
  for (let round = 0; round < 6; round += 1) {
    const report = await run(w.services);
    expect(report.requests).toBeLessThanOrEqual(40);
    expect(w.result('BTC', 7)?.historyEligible).toBe(true);
    expect(w.result('ETH', 7)?.historyEligible).toBe(true);
  }
  for (const coin of ['BTC', 'ETH']) for (const days of [7, 30, 90, 180, 365] as const) {
    expect(w.result(coin, days), `${coin}/${days}d`).toMatchObject({ coverage: 'complete' });
  }
});

it.each(['timeout', 'rate-limited'] as const)('preserves old long-window evidence through %s while recent windows reach the new cutoff, then recovers', async (failure) => {
  const w = hlBackfillWorld();
  for (let i = 0; i < 6; i += 1) await run(w.services);
  const old = w.result('BTC', 365)!;
  const cutoff = snapshotCutoff(Date.now()) + H;
  vi.setSystemTime(cutoff + 60_000);
  w.control.failure = failure;
  w.control.failBefore = cutoff - 7 * D;
  await run(w.services);
  for (const coin of ['BTC', 'ETH']) {
    expect(w.result(coin, 7)).toMatchObject({ cutoff, coverage: 'complete', historyEligible: true });
  }
  expect(w.result('BTC', 365)).toMatchObject({ cutoff: old.cutoff, coverage: 'complete', historyEligible: false,
    short: { verifiedAt: old.short.verifiedAt, lastAttempt: { outcome: 'error', reason: failure } } });
  w.control.failure = null;
  // Finish any pinned old-cutoff jobs, then both new-cutoff years within the same quota.
  for (let i = 0; i < 12; i += 1) {
    const report = await run(w.services);
    expect(report.requests).toBeLessThanOrEqual(40);
    if (['BTC', 'ETH'].every((coin) => w.result(coin, 365)?.cutoff === cutoff && w.result(coin, 365)?.coverage === 'complete')) break;
  }
  for (const coin of ['BTC', 'ETH']) expect(w.result(coin, 365)).toMatchObject({ cutoff, coverage: 'complete' });
}, 30_000);

it('keeps newly returned and retained conflicting rates quarantined after a cutoff change', async () => {
  const w = hlBackfillWorld();
  for (let i = 0; i < 6; i += 1) await run(w.services);
  vi.setSystemTime(snapshotCutoff(Date.now()) + H + 60_000);
  w.control.revised = true;
  await run(w.services);
  for (const coin of ['BTC', 'ETH']) for (const days of [7, 365] as const) {
    const result = w.result(coin, days)!;
    expect(result.coverage).toBe('unknown');
    expect(result.short.reasons).toContain('settlement-conflict');
    expect(result.netTotal).toBeNull();
  }
});

it('does not refresh evidence timestamps when rate limits prevent even the recent reads', async () => {
  const w = hlBackfillWorld();
  await run(w.services);
  const old = w.result('BTC', 7)!;
  vi.setSystemTime(snapshotCutoff(Date.now()) + H + 60_000);
  w.control.failure = 'rate-limited';
  await run(w.services);
  expect(w.result('BTC', 7)).toMatchObject({ cutoff: old.cutoff, historyEligible: false,
    short: { verifiedAt: old.short.verifiedAt, observedAt: old.short.observedAt,
      lastAttempt: { reason: 'rate-limited' } } });
});

it('quarantines a conflicting returned page immediately even if its older segment cannot finish this round', async () => {
  const w = hlBackfillWorld();
  for (let i = 0; i < 6; i += 1) await run(w.services);
  w.control.reviseBefore = snapshotCutoff(Date.now()) - 7 * D;
  // The next hourly settlement makes the legs due; the new job's older segment returns the revision.
  vi.setSystemTime(snapshotCutoff(Date.now()) + H + 60_000);
  w.control.failBefore = w.control.reviseBefore;
  w.control.allowBeforeFailure = 1;
  w.control.failure = 'rate-limited';
  await run(w.services);
  expect(['BTC', 'ETH'].some((coin) => w.result(coin, 365)?.short.reasons.includes('settlement-conflict'))).toBe(true);
  expect(w.result('BTC', 7)?.historyEligible).toBe(true);
  expect(w.result('ETH', 7)?.historyEligible).toBe(true);
});

it('drops future-cutoff work after a clock rollback rather than treating it as current evidence', async () => {
  const w = hlBackfillWorld();
  await run(w.services);
  const cutoff = snapshotCutoff(Date.now()) - H;
  vi.setSystemTime(cutoff + 60_000);
  await run(w.services);
  for (const coin of ['BTC', 'ETH']) expect(w.result(coin, 7)).toMatchObject({ cutoff, historyEligible: true });
});

it('preserves conflicts from a returned recent page even when no new segment completes', async () => {
  const w = hlBackfillWorld();
  for (let i = 0; i < 6; i += 1) await run(w.services);
  const old = new Map(['BTC', 'ETH'].map((coin) => [coin, w.result(coin, 365)!]));
  const before = w.calls.length;
  vi.setSystemTime(snapshotCutoff(Date.now()) + H + 60_000);
  w.control.revised = true;
  w.control.failure = 'rate-limited';
  w.control.allowBeforeFailure = 1;
  await run(w.services);
  const coin = w.calls[before]!.coin;
  const result = w.result(coin, 365)!;
  expect(result.short.reasons).toContain('settlement-conflict');
  expect(result.short.verifiedAt).toBe(old.get(coin)!.short.verifiedAt);
  expect(result.netTotal).toBeNull();
});
