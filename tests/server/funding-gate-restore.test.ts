import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher } from '../../src/core/funding/history-collector';
import { captureHistory, restoredSnapshot, type PersistedHistory } from '../../src/core/funding/history-persistence';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { openFundingHistoryStore } from '../../src/server/funding/history-store';
import { gateHistory, gateListing } from '../helpers/funding-gate-fixture';
import { CUTOFF, NOW } from '../helpers/funding-ranking-fixture';
import { run } from '../helpers/funding-history-stub';

const key = { venue: 'GATE', contractId: 'ETH_USDT' };
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-gate-')); vi.useFakeTimers({ now: NOW }); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

function refresher(cache: FundingHistoryCache, persist?: (state: PersistedHistory) => void) {
  const gate = gateHistory(CUTOFF, Date.now);
  const sources = createOfficialHistorySources({ read: gate.read, now: Date.now, context: () => ({ listing: gateListing, rules: [] }) });
  return { gate, refresher: createFundingHistoryRefresher({ cache, sources, legs: async () => [key], inferCadence: true,
    ...(persist ? { persist: (snapshot, progress, backfilled) => persist(captureHistory(snapshot, progress, backfilled)) } : {}) }) };
}
const window = (cache: FundingHistoryCache, days: 7 | 180) => cache.evaluate({ underlying: 'ETH', short: key, long: key, days }, Date.now())!;

it('restores a saved Gate read after a restart as observation only, until the next read re-proves it', async () => {
  const file = path.join(dir, 'funding-history.sqlite');
  const store = openFundingHistoryStore(file);
  await store.load();
  let saved: PersistedHistory | null = null;
  await run(refresher(new FundingHistoryCache(), (state) => { saved = state; }).refresher);
  await store.save(saved!);
  store.close();

  const reopened = openFundingHistoryStore(file);
  const loaded = await reopened.load();
  reopened.close();
  if (loaded.outcome !== 'restored') throw new Error(loaded.outcome);
  const cache = new FundingHistoryCache();
  cache.restore(restoredSnapshot(loaded.state));
  const restored = cache.snapshot()!.legs.get(legKey(key))!.leg;
  expect(restored.events.some((e) => e.rawTime !== undefined && e.rawTime !== e.settledAt && e.timeMappingEvidence)).toBe(true);
  expect(window(cache, 180)).toMatchObject({ historyEligible: false, short: { restored: true, fresh: false, total: '0.06' } });

  const next = refresher(cache);
  await run(next.refresher);
  expect(next.gate.requests.length).toBeGreaterThan(0);
  expect(window(cache, 180)).toMatchObject({ historyEligible: true, short: { total: '0.06' } });
  expect(window(cache, 180).short.restored).toBeUndefined();
});
