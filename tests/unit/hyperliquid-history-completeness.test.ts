import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createOfficialHistorySources, type OfficialHistoryOptions } from '../../src/core/funding/official-history';
import { createFundingHistoryRefresher, type HistoryCall } from '../../src/core/funding/history-collector';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import type { HyperliquidHourlyPolicy } from '../../src/core/funding/hyperliquid-policy';
import { createOfficialFundingCatalog } from '../../src/core/funding/official-catalog';
import { buildSettlementBoard } from '../../src/server/funding/settlements';
import { run } from '../helpers/funding-history-stub';

const H = 3_600_000;
const D = 24 * H;
const T = Date.UTC(2026, 9, 31);
const document = 'synthetic reviewed native hourly policy';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const call: HistoryCall = (_request, run) => run(new AbortController().signal);
const policy = (): HyperliquidHourlyPolicy => ({ version: 'fixture-hourly-v1', from: T - 380 * D,
  archive: { url: 'https://archive.example/official-policy', capturedAt: T - 400 * D, sha256: sha('archived fixture'), cdxDigest: 'A'.repeat(32) },
  current: { url: 'https://docs.example/funding.md', sha256: sha(document) },
  listedBy: Object.fromEntries(['BTC', 'ETH'].map((coin) => [coin, {
    request: `fixture fundingHistory ${coin} before window`, responseHash: sha(`first ${coin}`),
    raw: { coin, time: T - 500 * D + 48, fundingRate: '0.0001' },
  }])),
});
afterEach(() => vi.useRealTimers());

function world(opts: { missing?: number; conflict?: boolean; document?: string; policy?: HyperliquidHourlyPolicy; native?: boolean;
  context?: OfficialHistoryOptions['context'] } = {}) {
  vi.useFakeTimers({ now: T + 60_000 });
  let docReads = 0;
  const sources = createOfficialHistorySources({ hlPolicy: opts.policy ?? policy(), now: Date.now,
    context: opts.context ?? (() => opts.native === false ? null : { listing: null, rules: [] }),
    read: async (_venue, url, _signal, body) => {
      if (url.endsWith('/funding.md')) { docReads += 1; return opts.document ?? document; }
      const request = body as { coin: string; startTime: number; endTime: number };
      const rows = Array.from({ length: 365 * 24 }, (_, i) => ({ coin: request.coin,
        time: T - (365 * 24 - i - 1) * H + 48, fundingRate: request.coin === 'ETH' ? '-0.0001' : '0.0001' }))
        .filter((row) => row.time >= request.startTime && row.time <= request.endTime && row.time - 48 !== opts.missing);
      if (opts.conflict && rows.some((row) => row.time === T + 48)) rows.push({ coin: request.coin, time: T + 48, fundingRate: '0.99' });
      return rows.sort((a, b) => a.time - b.time).slice(0, 500);
    } });
  const cache = new FundingHistoryCache();
  const keys = ['BTC', 'ETH'].map((contractId) => ({ venue: 'HYPERLIQUID', contractId }));
  const refresher = createFundingHistoryRefresher({ sources, cache, legs: async () => keys,
    budget: { venueConcurrency: 1, globalRequests: 40, venueRequests: 40 } });
  return { sources, cache, keys, refresher, docReads: () => docReads };
}

it('verifies BTC/ETH five windows through the real collector within the existing 40-read budget', async () => {
  const w = world(); const report = await run(w.refresher);
  expect(report).toMatchObject({ requests: 39, venues: { HYPERLIQUID: { refreshed: 2, stopped: null } } });
  expect(w.docReads()).toBe(1);
  for (const key of w.keys) {
    const leg = w.cache.snapshot()!.legs.get(legKey(key))!.leg;
    expect(leg.listing).toMatchObject({ at: T - 500 * D + 48, kind: 'listed-by' });
    for (const days of [7, 30, 90, 180, 365] as const) {
      expect(w.cache.evaluate({ short: key, long: key, underlying: key.contractId, days }, Date.now()))
        .toMatchObject({ coverage: 'complete', historyEligible: true, short: { observed: { events: days * 24 } } });
    }
  }
});

it('keeps a missing UTC hour partial instead of inventing a zero', async () => {
  const w = world({ missing: T - H }); await run(w.refresher);
  expect(w.cache.evaluate({ short: w.keys[0], long: w.keys[1], underlying: 'BTC', days: 7 }, Date.now()))
    .toMatchObject({ coverage: 'partial', historyEligible: false, short: { total: null, missingEvents: [T - H] } });
});

it('quarantines conflicting values for the same hourly settlement', async () => {
  const w = world({ conflict: true }); await run(w.refresher);
  expect(w.cache.evaluate({ short: w.keys[0], long: w.keys[1], underlying: 'BTC', days: 7 }, Date.now()))
    .toMatchObject({ coverage: 'unknown', historyEligible: false, short: { observed: null, conflicts: [expect.objectContaining({ settledAt: T })] } });
});

it('keeps only the windows inside the reviewed historical scope eligible', async () => {
  const p = policy(); p.from = T - 100 * D;
  const w = world({ policy: p }); await run(w.refresher);
  expect(w.cache.evaluate({ short: w.keys[0], long: w.keys[1], underlying: 'BTC', days: 90 }, Date.now())?.coverage).toBe('complete');
  expect(w.cache.evaluate({ short: w.keys[0], long: w.keys[1], underlying: 'BTC', days: 180 }, Date.now())?.coverage).toBe('unknown');
});

it('keeps changed current documentation unverified while still showing actual records', async () => {
  const w = world({ document: document + ' changed' }); await run(w.refresher);
  expect(w.cache.evaluate({ short: w.keys[0], long: w.keys[1], underlying: 'BTC', days: 7 }, Date.now()))
    .toMatchObject({ coverage: 'unknown', historyEligible: false, short: { total: null, observed: { events: 168 } } });
});

it('does not overwrite a known recent native listing with the older listed-by upper bound', async () => {
  const w = world({ context: () => ({ listing: { at: T - 10 * D, evidence: 'fixture exact current listing', kind: 'listed-at' }, rules: [] }) });
  await run(w.refresher);
  expect(w.cache.evaluate({ short: w.keys[0], long: w.keys[1], underlying: 'BTC', days: 7 }, Date.now())?.coverage).toBe('complete');
  expect(w.cache.evaluate({ short: w.keys[0], long: w.keys[1], underlying: 'BTC', days: 30 }, Date.now()))
    .toMatchObject({ coverage: 'unknown', historyEligible: false, short: { reasons: expect.arrayContaining(['listing-history-insufficient']) } });
});

it('never adds the policy to uncorroborated native ids, HYPE, aliases or HIP-3', async () => {
  const w = world(); const source = w.sources.find((s) => s.venue === 'HYPERLIQUID')!;
  for (const id of ['HYPE', 'btc', 'xyz:BTC']) expect(await source.context(id, call)).toMatchObject({ rules: [] });
  expect(w.docReads()).toBe(0);
  const unmapped = world({ native: false });
  expect(await unmapped.sources.find((s) => s.venue === 'HYPERLIQUID')!.context('BTC', call)).toBeNull();
  expect(unmapped.docReads()).toBe(0);
});

it('rechecks the current document across UTC cutoffs and never grants a future range', async () => {
  const w = world(); const source = w.sources.find((s) => s.venue === 'HYPERLIQUID')!;
  expect((await source.context('BTC', call))?.rules[0]?.until).toBe(T + 1);
  vi.setSystemTime(T + H + 60_000);
  expect((await source.context('ETH', call))?.rules[0]?.until).toBe(T + H + 1);
  expect(w.docReads()).toBe(2);
});

it('revokes every cached read on a document change at the next due read, even when only the document fits the budget', async () => {
  const control = { document };
  const w = world(control); await run(w.refresher);
  const limited = () => createFundingHistoryRefresher({ sources: w.sources, cache: w.cache, legs: async () => w.keys,
    budget: { venueConcurrency: 1, venueRequests: 1, globalRequests: 1 } });
  control.document += ' unreviewed change';
  // The next hourly settlement makes the legs due; the document is the one read that fits.
  vi.setSystemTime(T + H + 60_000);
  await run(limited());
  for (const key of w.keys) {
    expect(w.cache.evaluate({ short: key, long: key, underlying: key.contractId, days: 365 }, Date.now()))
      .toMatchObject({ historyEligible: false, coverage: 'unknown', short: {
        observed: { events: 8760 }, reasons: expect.arrayContaining(['historical-policy-changed']),
      } });
  }
});

it('rejects a historical boundary preceding its archive and a mismatched listed-by coin', async () => {
  for (const failure of ['archive', 'coin'] as const) {
    const p = policy();
    if (failure === 'archive') p.from = p.archive.capturedAt - 1;
    else p.listedBy.BTC!.raw.coin = 'ETH';
    const w = world({ policy: p });
    expect(await w.sources.find((s) => s.venue === 'HYPERLIQUID')!.context('BTC', call)).toMatchObject({ rules: [], listing: null });
    expect(w.docReads()).toBe(0);
  }
});

it('wires native catalog proof through the production source to the formal settlement view', async () => {
  const catalog = createOfficialFundingCatalog({
    rules: async () => ['BTC', 'ETH', 'HYPE'].map((coin) => ({ symbol: `HYPERLIQUID_FUTURE_${coin}_USDC`,
      exchangeType: 'HYPERLIQUID', businessType: 'FUTURE', state: 'live', delistTime: '0' })),
    read: async () => ({ universe: ['BTC', 'ETH', 'HYPE'].map((name) => ({ name, szDecimals: 5 })) }),
  });
  const discovery = await catalog.contracts();
  const w = world({ context: (venue, id) => catalog.historyContext(venue, id) });
  await run(w.refresher);
  const view = buildSettlementBoard({ query: { offset: 0, limit: 20 }, history: w.cache, now: Date.now(),
    market: { contracts: { state: 'ready', at: Date.now(), lastAttempt: { at: Date.now(), ok: true }, listings: discovery.listings },
      current: new Map(), feeds: [] } });
  for (const row of view.rows.filter((row) => row.assetCode !== 'HYPE')) {
    expect(row.windows.every((window) => window.coverage === 'complete' && window.annualized !== null)).toBe(true);
  }
  expect(view.rows.find((row) => row.assetCode === 'HYPE')!.windows.every((window) => window.coverage !== 'complete')).toBe(true);
  expect(discovery.listings.map((listing) => [listing.contractId, listing.underlying?.id ?? null]))
    .toEqual([['BTC', 'BTC'], ['ETH', 'ETH'], ['HYPE', null]]);
});
