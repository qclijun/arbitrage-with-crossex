import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher } from '../../src/core/funding/history-collector';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { enumerateFundingCandidates, rankFundingCandidates } from '../../src/core/funding/ranking';
import { gateFundingListing, gateHistory, gateListing } from '../helpers/funding-gate-fixture';
import { nativeFundingHistories, nativeFundingListings } from '../helpers/funding-hyperliquid-fixture';
import { CUTOFF, D, H, NOW, publish } from '../helpers/funding-ranking-fixture';
import { run } from '../helpers/funding-history-stub';

const key = { venue: 'GATE', contractId: 'BTC_USDT' };
beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

async function collect(opts: Parameters<typeof gateHistory>[2] = {}) {
  const gate = gateHistory(CUTOFF, Date.now, opts);
  const cache = new FundingHistoryCache();
  const sources = createOfficialHistorySources({ read: gate.read, now: Date.now,
    context: (venue, id) => (venue === 'GATE' && id === 'BTC_USDT' ? { listing: gateListing, rules: [] } : null) });
  const report = await run(createFundingHistoryRefresher({ cache, sources, legs: async () => [key], inferCadence: true,
    budget: { venueConcurrency: 1 } }));
  return { cache, report, requests: gate.requests, entry: cache.snapshot()!.legs.get(legKey(key))! };
}
const window = (cache: FundingHistoryCache, days: 7 | 30 | 90 | 180 | 365) =>
  cache.evaluate({ underlying: 'BTC', short: key, long: key, days }, Date.now())!;

it('collects a Gate BTC year from REST and the monthly archive, inferring the 8h to 4h change without backfilling today\'s cadence', async () => {
  const { cache, report, requests, entry } = await collect();
  expect(report.venues.GATE).toMatchObject({ stopped: null, refreshed: 1 });
  // REST: the 7/30/90/180-day segments, one page each, never more than 180 days back.
  // Archive: October 2025 to April 2026 for the 365-day segment, first checked against
  // one REST read from REST's floor (in April) through May; April's file is read once.
  expect(requests.filter((u) => u.includes('api.gateio.ws'))).toHaveLength(5);
  expect(requests.filter((u) => u.includes('download.gatedata.org')).map((u) => u.split('/')[5])).toEqual(
    ['202605', '202604', '202603', '202602', '202601', '202512', '202511', '202510']);
  // Every settlement past REST's reach cites the archive file it came from, never the overlap's REST read.
  const archived = entry.leg.events.filter((e) => e.settledAt <= CUTOFF - 180 * D);
  expect(archived.length).toBeGreaterThan(0);
  expect(archived.every((e) => /^GET https:\/\/download\.gatedata\.org\/.+-(\d{6})\.csv\.gz#/.test(e.evidence))).toBe(true);
  expect(entry.leg.cadence).toMatchObject({ basis: 'inferred', intervals: [8, 4] });
  expect(entry.leg.rules.map((r) => r.everyHours)).toEqual([8, 4]);
  // 14 cycles of (0.0003, 0, -0.0001); 60; 90 days at 0.0001 + 120 cycles; 120 days + 120 cycles; 305 days + 120 cycles.
  const totals = { 7: '0.0028', 30: '0.012', 90: '0.033', 180: '0.06', 365: '0.1155' } as const;
  for (const days of [7, 30, 90, 180, 365] as const) {
    expect(window(cache, days)).toMatchObject({ coverage: 'complete', historyEligible: true, short: { total: totals[days] } });
  }
});

it('leaves the windows a failed or gapped read cannot prove UNKNOWN or PARTIAL, never zero', async () => {
  const failed = await collect({ fail: (url) => Number(url.searchParams.get('to')) <= (CUTOFF - 30 * D) / 1_000 + 60 });
  expect(failed.entry.leg.lastAttempt).toMatchObject({ outcome: 'error' });
  expect(window(failed.cache, 30)).toMatchObject({ coverage: 'complete', short: { total: '0.012' } });
  expect(window(failed.cache, 90)).toMatchObject({ historyEligible: false, short: { total: null } });
  expect(window(failed.cache, 90).coverage).not.toBe('complete');
  const gapped = await collect({ drop: CUTOFF - 3 * D });
  expect(window(gapped.cache, 7)).toMatchObject({ coverage: 'partial', historyEligible: false, netTotal: null,
    short: { missingEvents: [CUTOFF - 3 * D], total: null } });
});

it('ranks Gate against a CEX on one basis and against HL as a rate estimate, with positive-only filtering', async () => {
  const { entry } = await collect();
  const cache = publish([entry.leg, ...nativeFundingHistories('BTC')]);
  const { candidates } = enumerateFundingCandidates([...nativeFundingListings('BTC'), gateFundingListing('BTC')]);
  const id = (short: string, long: string) => candidates.find((c) => c.short.venue === short && c.long.venue === long)!.id;
  const page = rankFundingCandidates({ candidates, history: cache, now: Date.now(), days: 7, filter: { venues: ['GATE'] } });
  const row = (short: string, long: string) => page.rows.find((r) => r.candidate.id === id(short, long))!;
  // Gate 7d 0.0028; Binance 21 x 0.00008 = 0.00168; HL 168 x 0.00002 = 0.00336.
  expect(row('GATE', 'BINANCE')).toMatchObject({ rank: expect.any(Number), windows: [
    { days: 7, eligible: true, netTotal: '0.00112' }, { days: 30, eligible: true }, { days: 90, eligible: true },
    { days: 180, eligible: true }, { days: 365, eligible: true }] });
  expect(row('GATE', 'BINANCE').candidate).not.toHaveProperty('rateEstimate');
  expect(row('HYPERLIQUID', 'GATE')).toMatchObject({ rank: expect.any(Number), candidate: { rateEstimate: expect.any(Object) },
    windows: [{ days: 7, eligible: true, netTotal: '0.00056' }, {}, {}, {}, { days: 365, eligible: true }] });
  const positive = rankFundingCandidates({ candidates, history: cache, now: Date.now(), days: 7, filter: { venues: ['GATE'], positiveOnly: true } });
  const ids = positive.rows.map((r) => r.candidate.id);
  expect(ids).toContain(id('GATE', 'BINANCE'));
  expect(ids).toContain(id('HYPERLIQUID', 'GATE'));
  expect(ids).not.toContain(id('GATE', 'HYPERLIQUID'));
  // 365 days: Gate 0.1155 against Binance 1095 x 0.00008 = 0.0876 and HL 8760 x 0.00002 = 0.1752.
  const year = rankFundingCandidates({ candidates, history: cache, now: Date.now(), days: 365, filter: { venues: ['GATE'], positiveOnly: true } });
  expect(year.rows.find((r) => r.candidate.id === id('GATE', 'BINANCE'))?.windows[4]).toMatchObject({ netTotal: '0.0279' });
  expect(year.rows.find((r) => r.candidate.id === id('HYPERLIQUID', 'GATE'))?.windows[4]).toMatchObject({ netTotal: '0.0597' });
  expect(year.rows.map((r) => r.candidate.id)).not.toContain(id('BINANCE', 'GATE'));
});

it('reads Gate again only when a settlement is due, thirteen requests per leg', async () => {
  const gate = gateHistory(CUTOFF, Date.now);
  const cache = new FundingHistoryCache();
  const sources = createOfficialHistorySources({ read: gate.read, now: Date.now,
    context: () => ({ listing: gateListing, rules: [] }) });
  const eth = { venue: 'GATE', contractId: 'ETH_USDT' };
  const refresher = createFundingHistoryRefresher({ cache, sources, legs: async () => [key, eth], inferCadence: true });
  await run(refresher);
  expect(gate.requests).toHaveLength(26);
  vi.setSystemTime(CUTOFF + H + 60_000);
  expect(await run(refresher)).toMatchObject({ requests: 0 });
  // The next settlement on the inferred 4-hour cadence re-reads both legs' year: per leg four REST
  // pages, seven archive months and the overlap check (one REST read, one more month).
  // 26 requests, against Gate's 200 per 10 seconds.
  vi.setSystemTime(CUTOFF + 4 * H + 60_000);
  expect(await run(refresher)).toMatchObject({ requests: 26 });
});
