import { afterEach, expect, it, vi } from 'vitest';
import { boardWorld, type BoardWorld } from '../helpers/funding-board-fixture';
import { hlBackfillWorld } from '../helpers/funding-hl-backfill-fixture';
import { nativeFundingListings } from '../helpers/funding-hyperliquid-fixture';
import { D, H, run } from '../helpers/funding-history-stub';
import { snapshotCutoff } from '../../src/core/funding/history';
import { HOST } from './helpers/gate-nock';

let app: BoardWorld | undefined;
afterEach(async () => { await app?.app.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('serves each window at its own retained cutoff with freshness, attempt and backfill status from memory only', async () => {
  const w = hlBackfillWorld();
  for (let i = 0; i < 6; i += 1) await run(w.services);
  const old = w.result('BTC', 365)!;
  const cutoff = snapshotCutoff(Date.now()) + H;
  vi.setSystemTime(cutoff + 60_000);
  w.control.failure = 'timeout';
  w.control.failBefore = cutoff - 7 * D;
  await run(w.services);
  app = await boardWorld({ history: w.services.funding.history,
    listings: [...nativeFundingListings('BTC'), ...nativeFundingListings('ETH')].filter((l) => l.venue === 'HYPERLIQUID') });
  app.clock.t = Date.now();
  const before = w.calls.length;
  for (let i = 0; i < 2; i += 1) {
    const response = await app.app.inject({ method: 'GET', url: '/api/funding/settlements?venue=HYPERLIQUID', headers: HOST });
    expect(response.statusCode).toBe(200);
    const row = response.json().data.rows.find((r: { assetCode: string }) => r.assetCode === 'BTC');
    expect(row.windows[0]).toMatchObject({ cutoff, coverage: 'complete', fresh: true });
    expect(row.windows[4]).toMatchObject({ cutoff: old.cutoff, coverage: 'complete', fresh: false,
      verifiedAt: old.short.verifiedAt, lastAttempt: { outcome: 'error', reason: 'timeout' } });
    expect(row.windows[4].reasons).toContain('timeout');
    expect(row.windows[4].reasons).toContain('history-cutoff-behind');
    expect(row.backfill).toMatchObject({ cutoff: old.cutoff, pagesRead: expect.any(Number) });
  }
  expect(w.calls).toHaveLength(before);
  w.control.failure = null;
  for (let i = 0; i < 12; i += 1) {
    await run(w.services);
    if (['BTC', 'ETH'].every((coin) => w.result(coin, 365)?.cutoff === cutoff && w.result(coin, 365)?.coverage === 'complete')) break;
  }
  app.clock.t = Date.now();
  const recovered = await app.app.inject({ method: 'GET', url: '/api/funding/settlements?venue=HYPERLIQUID', headers: HOST });
  for (const row of recovered.json().data.rows) {
    expect(row.windows[4]).toMatchObject({ cutoff, coverage: 'complete', fresh: true });
    expect(row.windows[4].verifiedAt).toBeGreaterThan(old.short.verifiedAt!);
    expect(row.windows[4].reasons).not.toContain('timeout');
  }
}, 30_000);
