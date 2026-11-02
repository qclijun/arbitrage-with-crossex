import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher } from '../../src/core/funding/history-collector';
import { captureHistory, restoredSnapshot, type PersistedHistory } from '../../src/core/funding/history-persistence';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { openFundingHistoryStore } from '../../src/server/funding/history-store';
import { lighterHistory, lighterListing } from '../helpers/funding-lighter-fixture';
import { CUTOFF, NOW } from '../helpers/funding-ranking-fixture';
import { run } from '../helpers/funding-history-stub';

const key = { venue: 'LIGHTER', contractId: 'ETH' };
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-lighter-')); vi.useFakeTimers({ now: NOW }); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

function refresher(cache: FundingHistoryCache, opts: { budget?: { venueRequests: number }; persist?: (s: PersistedHistory) => void } = {}) {
  const lighter = lighterHistory(CUTOFF);
  const sources = createOfficialHistorySources({ read: lighter.read, now: Date.now, context: () => ({ listing: lighterListing, rules: [] }) });
  return { lighter, refresher: createFundingHistoryRefresher({ cache, sources, legs: async () => [key], inferCadence: true, budget: opts.budget,
    ...(opts.persist ? { persist: (snapshot, progress, backfilled) => opts.persist!(captureHistory(snapshot, progress, backfilled)) } : {}) }) };
}
const window = (cache: FundingHistoryCache, days: 30 | 365) => cache.evaluate({ underlying: 'ETH', short: key, long: key, days }, Date.now())!;

it('resumes a budget-cut Lighter backfill after a restart without starting the year over, showing it as restored', async () => {
  const file = path.join(dir, 'funding-history.sqlite');
  const store = openFundingHistoryStore(file);
  await store.load();
  let saved: PersistedHistory | null = null;
  const first = refresher(new FundingHistoryCache(), { budget: { venueRequests: 6 }, persist: (state) => { saved = state; } });
  await run(first.refresher);
  expect(saved!.progress.get(legKey(key))).toMatchObject({ done: false });
  await store.save(saved!);
  store.close();

  const reopened = openFundingHistoryStore(file);
  const loaded = await reopened.load();
  reopened.close();
  if (loaded.outcome !== 'restored') throw new Error(loaded.outcome);
  const cache = new FundingHistoryCache();
  cache.restore(restoredSnapshot(loaded.state));
  expect(window(cache, 30)).toMatchObject({ historyEligible: false, short: { restored: true } });

  vi.setSystemTime(NOW + 10 * 60_000);
  const next = refresher(cache);
  next.refresher.restore(loaded.state);
  await run(next.refresher);
  // The saved job's later pages only, plus the recent re-read and the hour's mapping: a cold year is 13.
  expect(next.lighter.requests.length).toBeLessThan(13);
  expect(window(cache, 30)).toMatchObject({ historyEligible: true, short: { total: '0.00192' } });
  // Pages read before the restart were not re-proved here: the year is observation only until the next read.
  expect(window(cache, 365)).toMatchObject({ coverage: 'complete', historyEligible: false,
    short: { restored: true, fresh: false, total: '0.02336' } });
});
