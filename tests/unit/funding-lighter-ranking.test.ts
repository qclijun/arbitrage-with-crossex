import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher } from '../../src/core/funding/history-collector';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { enumerateFundingCandidates, rankFundingCandidates } from '../../src/core/funding/ranking';
import { lighterFundingListing, lighterHistory, lighterListing } from '../helpers/funding-lighter-fixture';
import { nativeFundingHistories, nativeFundingListings } from '../helpers/funding-hyperliquid-fixture';
import { CUTOFF, D, H, NOW, publish } from '../helpers/funding-ranking-fixture';
import { run } from '../helpers/funding-history-stub';

const btc = { venue: 'LIGHTER', contractId: 'BTC' };
const eth = { venue: 'LIGHTER', contractId: 'ETH' };
beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

function setup(opts: Parameters<typeof lighterHistory>[1] = {}, legs = [btc]) {
  const lighter = lighterHistory(CUTOFF, opts);
  const cache = new FundingHistoryCache();
  const sources = createOfficialHistorySources({ read: lighter.read, now: Date.now,
    context: (venue) => (venue === 'LIGHTER' ? { listing: lighterListing, rules: [] } : null) });
  const refresher = createFundingHistoryRefresher({ cache, sources, legs: async () => legs, inferCadence: true });
  return { lighter, cache, refresher };
}
const window = (cache: FundingHistoryCache, days: 7 | 30 | 90 | 180 | 365, key = btc) =>
  cache.evaluate({ underlying: key.contractId, short: key, long: key, days }, Date.now())!;
// Each three hours net 0.0012% - 0.0004% = 0.000008: 56, 240, 720, 1440 and 2920 of them.
const TOTALS = { 7: '0.000448', 30: '0.00192', 90: '0.00576', 180: '0.01152', 365: '0.02336' } as const;

it('collects a year of hourly Lighter BTC history as a bounded backfill and proves all five windows', async () => {
  const { lighter, cache, refresher } = setup();
  const report = await run(refresher);
  expect(report.venues.LIGHTER).toMatchObject({ stopped: null });
  // One order-book read, then 1 + 2 + 3 + 6 fundings pages for the 30/90/180/365-day segments.
  expect(lighter.requests.filter((r) => r.includes('orderBooks'))).toHaveLength(1);
  expect(lighter.requests.filter((r) => r.includes('fundings'))).toHaveLength(12);
  expect(cache.snapshot()!.legs.get(legKey(btc))!.leg.cadence).toMatchObject({ basis: 'inferred', intervals: [1] });
  for (const days of [7, 30, 90, 180, 365] as const) {
    expect(window(cache, days)).toMatchObject({ coverage: 'complete', historyEligible: true, short: { total: TOTALS[days] } });
  }
});

it('reads again only when the next hour settles, the recent pages first, inside the round budget', async () => {
  const { lighter, refresher } = setup({}, [btc, eth]);
  await run(refresher);
  const before = lighter.requests.length;
  vi.setSystemTime(CUTOFF + 30 * 60_000);
  expect(await run(refresher)).toMatchObject({ requests: 0 });
  lighter.settle(CUTOFF + H);
  vi.setSystemTime(CUTOFF + H + 60_000);
  const report = await run(refresher);
  // Evidence is never spliced across cutoffs, so the year is read again: the
  // hour's order-book read, both legs' recent pages, then 11 backfill pages each.
  expect(report.requests).toBe(25);
  expect(lighter.requests.slice(before, before + 3).map((u) => new URL(u).searchParams.get('end_timestamp')))
    .toEqual([null, String((CUTOFF + H) / 1_000 + 1), String((CUTOFF + H) / 1_000 + 1)]);
});

it('shows a missing hour as PARTIAL in the windows that contain it, never as complete', async () => {
  const { cache, refresher } = setup({ drop: CUTOFF - 100 * D });
  await run(refresher);
  expect(window(cache, 90)).toMatchObject({ coverage: 'complete', historyEligible: true });
  expect(window(cache, 180)).toMatchObject({ coverage: 'partial', historyEligible: false, netTotal: null,
    short: { missingEvents: [CUTOFF - 100 * D], total: null } });
});

it('leaves windows a failed backfill page cannot prove short of complete, keeping the proved ones', async () => {
  const { cache, refresher } = setup({ fail: (url) => Number(url.searchParams.get('end_timestamp')) < (CUTOFF - 200 * D) / 1_000 });
  await run(refresher);
  expect(window(cache, 180)).toMatchObject({ coverage: 'complete', short: { total: TOTALS[180] } });
  expect(window(cache, 365)).toMatchObject({ historyEligible: false, short: { total: null } });
  expect(window(cache, 365).coverage).not.toBe('complete');
});

it('ranks Lighter in all five windows, labelling every pair a cross-basis estimate', async () => {
  const { cache: collected, refresher } = setup();
  await run(refresher);
  const cache = publish([collected.snapshot()!.legs.get(legKey(btc))!.leg, ...nativeFundingHistories('BTC')]);
  const { candidates } = enumerateFundingCandidates([...nativeFundingListings('BTC'), lighterFundingListing('BTC')]);
  const id = (short: string, long: string) => candidates.find((c) => c.short.venue === short && c.long.venue === long)!.id;
  const lighterPairs = candidates.filter((c) => c.short.venue === 'LIGHTER' || c.long.venue === 'LIGHTER');
  expect(lighterPairs).toHaveLength(8);
  expect(lighterPairs.every((c) => c.rateEstimate)).toBe(true);
  for (const days of [7, 30, 90, 180, 365] as const) {
    const page = rankFundingCandidates({ candidates, history: cache, now: Date.now(), days, filter: { venues: ['LIGHTER'] } });
    expect(page.rows.every((r) => r.rank !== null), `days ${days}`).toBe(true);
  }
  // 7d: Lighter 0.000448; Binance 21 x 0.00008 = 0.00168; HL 168 x 0.00002 = 0.00336.
  const positive = rankFundingCandidates({ candidates, history: cache, now: Date.now(), days: 7,
    filter: { venues: ['LIGHTER'], positiveOnly: true } });
  expect(positive.rows.find((r) => r.candidate.id === id('BINANCE', 'LIGHTER'))?.windows[0]).toMatchObject({ netTotal: '0.001232' });
  expect(positive.rows.map((r) => r.candidate.id)).not.toContain(id('LIGHTER', 'BINANCE'));
});
