import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../src/core/boros/client';
import { TtlCache } from '../../src/server/cache';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

const market = (marketId = 197, venue = 'Binance', maturity = 1793318400) => ({
  marketId, tokenId: 2, address: '0xmarket', isMatured: false, isUiWhitelisted: true,
  platform: { platformId: venue, name: venue },
  metadata: { name: 'ETHUSDT', underlyingSymbol: 'ETH', fundingRateSymbol: 'ETHUSDT' },
  imData: { maturity }, data: { volume24h: 939.378609758163, notionalOI: 1861.4854741222807 },
});
const book = () => ({
  long: { ia: [0, -10], sz: ['1000000000000000001', '2000000000000000000'] },
  short: { ia: [20], sz: ['3900000000000000'] },
  syncStatus: { blockNumber: 512479177, timestamp: 1791353356 },
});
const bodies = () => ({
  '/apis/v1/markets': { results: [market()], resumeToken: null,
    syncStatus: { blockNumber: 512479175, timestamp: 1791353350 } },
  '/apis/v1/assets': { results: [{ tokenId: 2, id: 'ETH', symbol: 'WETH', decimals: 18, isCollateral: true }] },
  '/apis/v1/markets/order-book?marketId=197': book(),
});
let app: FastifyInstance;
afterEach(async () => { await app?.close(); vi.useRealTimers(); });
const read = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/boros/liquidity', headers: HOST });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

describe('GET /api/boros/liquidity', () => {
  it('returns public market statistics and exact raw YU with independent source clocks', async () => {
    const calls: string[] = [];
    app = makeTestApp({ borosFetch: borosStub(bodies(), calls) });
    const data = await read();
    expect(data.scope).toMatchObject({ isMatured: false, isUiWhitelisted: true, includeAmm: false });
    expect(data.markets).toHaveLength(1);
    const snapshot = data.markets[0];
    expect(snapshot.identity.value).toMatchObject({ marketId: 197, platformId: 'Binance', symbol: 'ETHUSDT', maturity: 1793318400 });
    expect(snapshot.volume24hYu).toMatchObject({ value: 939.378609758163, unit: 'YU', sourceObservedAt: null });
    expect(snapshot.volume24hYu.reason).toContain('UNKNOWN_SOURCE_TIME');
    expect(snapshot.notionalOiOneSidedYu.value).toBe(1861.4854741222807);
    expect(snapshot.oiConvention).toBe('one-sided');
    expect(snapshot.book.bids.value[0]).toEqual({ aggregateIndex: 0, apr: 0, sizeRaw: '1000000000000000001', sizeYu: '1.000000000000000001' });
    expect(snapshot.book.bids.sourceObservedAt).toBe(1791353356000);
    expect(snapshot.book.bids.completeness).toBe('partial');
    expect(snapshot.book.bids.reason).toContain('FULL_BOOK_COVERAGE_UNKNOWN');
    expect(snapshot.book.coverage).toBe('returned-levels');
    expect(calls.every(path => /^\/apis\/v1\/(markets(?:\?|\/order-book\?)|assets\?)/.test(path))).toBe(true);
    expect(calls.find(path => path.includes('/markets?'))).toContain('isUiWhitelisted=true');
    expect(calls.find(path => path.includes('/order-book?'))).toContain('includeAmm=false');
  });

  it('keeps distinct venues and maturities across completed pages', async () => {
    const stub = borosStub(bodies());
    app = makeTestApp({ borosFetch: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/markets')) return { ok: true, status: 200, json: async () =>
        parsed.searchParams.has('resumeToken')
          ? { results: [market(199, 'Lighter'), market(209, 'Binance', 1795737600)], resumeToken: null }
          : { results: [market()], resumeToken: 'next page' } };
      if (parsed.pathname.endsWith('/order-book')) return { ok: true, status: 200, json: async () => book() };
      return stub(url, init);
    } });
    const data = await read();
    expect(data.coverage).toMatchObject({ completeness: 'complete', value: { pages: 2, returnedMarkets: 3, resumeToken: null } });
    expect(data.markets.map((m: any) => m.identity.value.platformId)).toEqual(['Binance', 'Lighter', 'Binance']);
    expect(new Set(data.markets.map((m: any) => m.marketKey)).size).toBe(3);
    expect(data.markets[2].identity.value.maturity).toBe(1795737600);
  });

  it('retains successful pages and per-field values when a later page fails', async () => {
    const stub = borosStub(bodies());
    app = makeTestApp({ borosFetch: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/markets')) return parsed.searchParams.has('resumeToken')
        ? { ok: false, status: 429, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ results: [market()], resumeToken: 'next' }) };
      return stub(url, init);
    } });
    const data = await read();
    expect(data.coverage.completeness).toBe('partial');
    expect(data.coverage.reason).toContain('PAGINATION_INCOMPLETE');
    expect(data.coverage.reason).toContain('REQUEST_FAILED:rate-limited');
    expect(data.markets[0].volume24hYu).toMatchObject({ value: 939.378609758163, completeness: 'partial' });
    expect(data.markets[0].book.asks.value).toHaveLength(1);
  });

  it.each([
    [{ results: [market()] }, 'INVALID_RESUME_TOKEN'],
    [{ results: [market()], resumeToken: 'same' }, 'PAGINATION_NOT_PROGRESSING'],
    [{ results: [market(199), market(197)], resumeToken: null }, 'MARKET_ORDER_INVALID'],
  ])('does not claim a complete listing for malformed or non-progressing pages', async (page, reason) => {
    const input = bodies();
    app = makeTestApp({ borosFetch: borosStub({ ...input, '/apis/v1/markets': page }) });
    const data = await read();
    expect(data.coverage.completeness).toBe('partial');
    expect(data.coverage.reason).toContain(reason);
  });

  it('keeps missing statistics, identity and a failed side UNKNOWN without erasing the valid side', async () => {
    const input = bodies();
    app = makeTestApp({ borosFetch: borosStub({ ...input,
      '/apis/v1/markets': { results: [{ marketId: 197, data: { volume24h: 0, notionalOI: null } }], resumeToken: null },
      '/apis/v1/assets': { results: [] },
      '/apis/v1/markets/order-book?marketId=197': { long: { ia: [0], sz: [] }, short: { ia: [-10], sz: ['1'] } },
    }) });
    const snapshot = (await read()).markets[0];
    expect(snapshot.identity.completeness).toBe('partial');
    expect(snapshot.identity.value.tokenId).toBeNull();
    expect(snapshot.collateral.value).toBeNull();
    expect(snapshot.volume24hYu.value).toBe(0);
    expect(snapshot.notionalOiOneSidedYu).toMatchObject({ value: null, raw: null, completeness: 'unknown' });
    expect(snapshot.book.bids.value).toBeNull();
    expect(snapshot.book.bids.reason).toContain('MISSING_OR_MISMATCHED_SIDE');
    expect(snapshot.book.asks.value).toEqual([{ aggregateIndex: -10, apr: -0.001, sizeRaw: '1', sizeYu: '0.000000000000000001' }]);
    expect(snapshot.book.asks.sourceObservedAt).toBeNull();
  });

  it('distinguishes a complete empty response from an unavailable book and listing', async () => {
    const input = bodies();
    app = makeTestApp({ borosFetch: borosStub({ ...input,
      '/apis/v1/markets': { results: [market(), market(199)], resumeToken: null },
      '/apis/v1/markets/order-book?marketId=197': { long: { ia: [], sz: [] }, short: { ia: [], sz: [] } },
    }) });
    const data = await read();
    expect(data.markets[0].book.bids).toMatchObject({ value: [], completeness: 'complete', returnedLevels: 0, validLevels: 0 });
    expect(data.markets[1].book.bids).toMatchObject({ value: null, completeness: 'unknown' });
    await app.close();
    app = makeTestApp({ borosFetch: borosStub({ '/apis/v1/markets': { results: [], resumeToken: null } }) });
    expect((await read()).coverage.completeness).toBe('complete');
    await app.close();
    app = makeTestApp({ borosFetch: borosStub({}) });
    const failed = await read();
    expect(failed.coverage.completeness).toBe('unknown');
    expect(failed.coverage.collectedAt).toBeNull();
    expect(failed.coverage.reason).toContain('REQUEST_FAILED:network');
    expect(failed.markets).toEqual([]);
  });

  it('records server caps, discarded levels and raw inputs without claiming full depth', async () => {
    const input = bodies();
    const indices = Array.from({ length: 51 }, (_, i) => i);
    app = makeTestApp({ borosFetch: borosStub({ ...input,
      '/apis/v1/markets/order-book?marketId=197': {
        long: { ia: indices, sz: indices.map(() => '1') },
        short: { ia: [10, 20, 30, 40, 50, 10.5, 10], sz: ['1', '0', '-1', '1.1', 1, '1', '2'] },
      },
    }) });
    const snapshot = (await read()).markets[0];
    expect(snapshot.book.bids).toMatchObject({ returnedLevels: 51, validLevels: 50, serverLevelCap: 50, potentiallyTruncated: true, completeness: 'partial' });
    expect(snapshot.book.bids.reason).toContain('CLIENT_TRUNCATED');
    expect(snapshot.book.bids.raw.ia).toHaveLength(51);
    expect(snapshot.book.asks.discardedLevels).toBe(6);
    expect(snapshot.book.asks.reason).toContain('INVALID_OR_DUPLICATE_LEVELS');
    expect(snapshot.book.asks.value[0].sizeRaw).toBe('1');
  });

  it.each([null, '1791353356', 1791353356000, 1, 9999999999])('rejects unverified book timestamp %s', async timestamp => {
    app = makeTestApp({ borosFetch: borosStub({ ...bodies(),
      '/apis/v1/markets/order-book?marketId=197': { ...book(), syncStatus: { timestamp } },
    }) });
    const side = (await read()).markets[0].book.bids;
    expect(side.sourceObservedAt).toBeNull();
    expect(side.sourceSyncStatus).toEqual({ timestamp });
    expect(side.reason).toContain('UNKNOWN_SOURCE_TIME');
  });

  it('uses separate TTLs and retains expired snapshots on 429 without bypassing cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1791353356000);
    const calls: string[] = [];
    let failed = false;
    const stub = borosStub(bodies(), calls);
    const fetchImpl: FetchLike = async (url, init) => failed
      ? (calls.push(new URL(url).pathname), { ok: false, status: 429, json: async () => ({}) })
      : stub(url, init);
    const cache = new TtlCache();
    await cache.get('boros:markets', 30_000, async () => ['legacy normalized data']);
    await cache.get('boros:book:197', 90_000, async () => 'legacy book');
    const clients = vi.fn(() => { throw new Error('account reads forbidden'); });
    const orders = vi.fn(() => { throw new Error('write port forbidden'); });
    app = makeTestApp({ borosFetch: fetchImpl, cache, getClients: clients, getBorosOrders: orders, engine: undefined });
    const first = await read();
    expect(first.markets[0].book.bids.freshness).toBe('fresh');
    expect(first.markets[0].volume24hYu.freshness).toBe('unknown');
    const initialCalls = calls.length;
    await read();
    expect(calls).toHaveLength(initialCalls);
    vi.setSystemTime(1791353387000);
    const refreshed = await read();
    expect(refreshed.markets[0].volume24hYu.collectedAt).toBe(1791353387000);
    expect(refreshed.markets[0].book.bids.collectedAt).toBe(1791353356000);
    expect(calls.filter(path => path.includes('/order-book'))).toHaveLength(1);
    vi.setSystemTime(1791353447000);
    failed = true;
    const stale = await read();
    expect(stale.markets[0].volume24hYu).toMatchObject({ value: 939.378609758163, collectedAt: 1791353387000, freshness: 'stale' });
    expect(stale.markets[0].book.bids.freshness).toBe('stale');
    expect(stale.markets[0].book.bids.reason).toContain('REQUEST_FAILED:rate-limited');
    const afterFailure = calls.length;
    await read();
    expect(calls).toHaveLength(afterFailure);
    expect(clients).not.toHaveBeenCalled();
    expect(orders).not.toHaveBeenCalled();
    expect(cache.peek('boros:markets')?.value).toEqual(['legacy normalized data']);
    expect(cache.peek('boros:book:197')?.value).toBe('legacy book');
    expect((await app.inject({ method: 'GET', url: '/api/boros/liquidity?fresh=1', headers: HOST })).statusCode).toBe(400);
  });

  it('retains the previous market and book on transport failure without changing their collection clocks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1791353356000);
    let down = false;
    const stub = borosStub(bodies());
    app = makeTestApp({ borosFetch: async (url, init) => {
      expect(init?.method ?? 'GET').toBe('GET');
      if (down) throw new Error('transport unavailable');
      return stub(url, init);
    } });
    await read();
    vi.setSystemTime(1791353456000);
    down = true;
    const data = await read();
    expect(data.coverage.freshness).toBe('stale');
    expect(data.markets[0].book.bids).toMatchObject({ value: [{ aggregateIndex: 0, apr: 0, sizeRaw: '1000000000000000001', sizeYu: '1.000000000000000001' },
      { aggregateIndex: -10, apr: -0.001, sizeRaw: '2000000000000000000', sizeYu: '2' }],
      collectedAt: 1791353356000, freshness: 'stale' });
    expect(data.markets[0].book.bids.reason).toContain('RETAINED_PREVIOUS_SNAPSHOT');
    expect(data.markets[0].collateral.reason).toContain('REQUEST_FAILED:network');
  });

  it('isolates book caches per market and preserves a best-50 response as partial', async () => {
    const input = bodies();
    const indices = Array.from({ length: 50 }, (_, i) => i);
    app = makeTestApp({ borosFetch: borosStub({ ...input,
      '/apis/v1/markets': { results: [market(), market(199)], resumeToken: null },
      '/apis/v1/markets/order-book?marketId=199': {
        long: { ia: indices, sz: indices.map(() => '2') }, short: { ia: [], sz: [] },
      },
    }) });
    const data = await read();
    expect(data.markets[0].book.bids.value[0].sizeRaw).toBe('1000000000000000001');
    expect(data.markets[1].book.bids.value[0].sizeRaw).toBe('2');
    expect(data.markets[1].book.bids).toMatchObject({ completeness: 'partial', validLevels: 50, potentiallyTruncated: true });
    expect(data.markets[1].book.bids.reason).not.toContain('CLIENT_TRUNCATED');
    expect(data.markets[1].book.asks.completeness).toBe('complete');
    expect((await read()).markets[1].book.bids.value[0].sizeRaw).toBe('2');
  });

  it('rejects non-schema statistics and malformed asset metadata rather than coercing to zero', async () => {
    const input = bodies();
    app = makeTestApp({ borosFetch: borosStub({ ...input,
      '/apis/v1/markets': { results: [{ ...market(), data: { volume24h: '', notionalOI: -1 } }], resumeToken: null },
      '/apis/v1/assets': { results: [{ tokenId: 2, id: 'ETH' }, { tokenId: 2, symbol: 'WETH' }] },
    }) });
    const snapshot = (await read()).markets[0];
    expect(snapshot.volume24hYu).toMatchObject({ value: null, raw: '', completeness: 'unknown' });
    expect(snapshot.notionalOiOneSidedYu.value).toBeNull();
    expect(snapshot.collateral.value).toBeNull();
    expect(snapshot.collateral.reason).toContain('COLLATERAL_MISSING_OR_AMBIGUOUS');
  });
});
