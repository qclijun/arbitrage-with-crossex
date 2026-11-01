import { afterEach, expect, it, vi } from 'vitest';
import { legKey, type CachedHistoryLeg } from '../../src/core/funding/history-cache';
import { legDue } from '../../src/core/funding/history-collector';
import { CUTOFF, flat, historyLeg, H, M } from '../helpers/funding-ranking-fixture';
import { BTC, T, pair, run, setup } from '../helpers/funding-history-stub';

afterEach(() => { vi.useRealTimers(); });

// An 8-hour leg read at CUTOFF (00:00 UTC): its next settlement is 08:00.
const cached = (patch: Partial<CachedHistoryLeg['leg']> = {}): CachedHistoryLeg =>
  ({ cutoff: CUTOFF, leg: { ...historyLeg('BINANCE', 'BTCUSDT', flat('0.0001')), ...patch } });

it('carries a read with nothing settled since, and reads again once its next settlement is due', () => {
  expect(legDue(cached(), CUTOFF, null, CUTOFF + 11 * M)).toEqual({ due: false });
  expect(legDue(cached(), CUTOFF + 3 * H, null, CUTOFF + 3 * H + M)).toMatchObject({ due: false,
    carried: { from: CUTOFF, cutoff: CUTOFF + 3 * H, next: CUTOFF + 8 * H } });
  expect(legDue(cached(), CUTOFF + 8 * H, null, CUTOFF + 8 * H + M)).toEqual({ due: true });
});

it('reads a leg never read, restored, failed or without a cadence', () => {
  expect(legDue(undefined, CUTOFF, null, CUTOFF + M)).toEqual({ due: true });
  expect(legDue(cached({ restored: true }), CUTOFF, null, CUTOFF + M)).toEqual({ due: true });
  expect(legDue(cached({ lastAttempt: { at: CUTOFF + M, outcome: 'error', reason: 'timeout' } }), CUTOFF, null, CUTOFF + 2 * M))
    .toEqual({ due: true });
  expect(legDue(cached({ rules: [] }), CUTOFF + H, null, CUTOFF + H + M)).toEqual({ due: true });
});

it('follows the venue feed when it says the cadence changed', () => {
  // The feed moved to 4 hours: its last settlement (04:00) is after the read.
  expect(legDue(cached(), CUTOFF + 5 * H, { intervalHours: 4, nextAt: CUTOFF + 8 * H }, CUTOFF + 5 * H + M)).toEqual({ due: true });
  // Its next one (04:00) comes before the cadence's 08:00: the carry ends there.
  expect(legDue(cached(), CUTOFF + 2 * H, { intervalHours: 4, nextAt: CUTOFF + 4 * H }, CUTOFF + 2 * H + M))
    .toMatchObject({ due: false, carried: { next: CUTOFF + 4 * H } });
  // A stale feed from before the read says nothing.
  expect(legDue(cached(), CUTOFF + 2 * H, { intervalHours: 8, nextAt: CUTOFF }, CUTOFF + 2 * H + M))
    .toMatchObject({ due: false, carried: { next: CUTOFF + 8 * H } });
});

it('reads again, even within the hour, when the read lacks the settlement due at its cutoff', () => {
  const read = cached();
  const early = cached({ events: read.leg.events.filter((event) => event.settledAt !== CUTOFF) });
  expect(legDue(early, CUTOFF, null, CUTOFF + 11 * M)).toEqual({ due: true });
  expect(legDue(early, CUTOFF + 3 * H, null, CUTOFF + 3 * H + M)).toEqual({ due: true });
});

it('lets an unfinished staged backfill continue by itself, without repeating this cutoff\'s recent read', () => {
  const failed = cached({ lastAttempt: { at: CUTOFF + 2 * M, outcome: 'error', reason: 'deadline' } });
  expect(legDue(failed, CUTOFF, null, CUTOFF + 11 * M, true)).toEqual({ due: false });
  expect(legDue(failed, CUTOFF, null, CUTOFF + 11 * M)).toEqual({ due: true });
  // A recent read from an earlier cutoff is still repeated.
  expect(legDue(failed, CUTOFF + 3 * H, null, CUTOFF + 3 * H + M, true)).toEqual({ due: true });
});

it('reads a leg again each round until the venue posts the settlement due at its cutoff', async () => {
  vi.useFakeTimers({ now: T + M });
  const late: { drop?: number } = { drop: T - 2 * H }; // 08:00, the last settlement before T (10:00)
  const { cache, binance, bybit, refresher } = setup({ bybit: late });
  await run(refresher);
  expect(cache.evaluate(pair(7), Date.now())!.long).toMatchObject({ coverage: 'partial', missingEvents: [T - 2 * H] });
  const [a, b] = [binance.calls.length, bybit.calls.length];
  delete late.drop;
  vi.setSystemTime(T + 11 * M);
  await run(refresher);
  expect([binance.calls.length, bybit.calls.length > b]).toEqual([a, true]);
  expect(cache.evaluate(pair(7), Date.now())).toMatchObject({ coverage: 'complete', historyEligible: true });
  vi.setSystemTime(T + 21 * M);
  expect(await run(refresher)).toMatchObject({ outcome: 'unchanged', requests: 0 });
});

it('publishes a due attempt that failed before it sent any request', async () => {
  vi.useFakeTimers({ now: T + M });
  const { cache, binance, refresher } = setup({ legs: [BTC.binance] });
  await run(refresher);
  const published = cache.view(Date.now()).snapshotId;
  binance.source.context = async () => { throw new Error('down'); };
  vi.setSystemTime(T + 6 * H + M); // 16:00 settled
  expect(await run(refresher)).toMatchObject({ outcome: 'published', requests: 0 });
  const failed = cache.view(Date.now()).snapshotId;
  expect(failed).not.toBe(published);
  // The retry in the same hour fails the same way: its attempt is published too, not dropped as unchanged.
  vi.setSystemTime(T + 6 * H + 11 * M);
  expect(await run(refresher)).toMatchObject({ outcome: 'published', requests: 0 });
  expect(cache.view(Date.now()).snapshotId).not.toBe(failed);
  expect(cache.snapshot()!.legs.get(legKey(BTC.binance))!.leg.lastAttempt)
    .toMatchObject({ at: T + 6 * H + 11 * M, outcome: 'error', reason: 'source-error' });
});
