import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';
import * as positionRoutes from '../../src/server/routes/positions';

describe('GET /api/account', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  it('returns the ok envelope with camelCase account fields', async () => {
    app = makeTestApp();
    const scope = mockGateGet('/accounts', { fixture: 'account.json' });

    const res = await app.inject({ method: 'GET', url: '/api/account', headers: HOST });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.marginBalance).toBe('993.4877'); // margin_balance → camelCase by the SDK
    expect(body.data.assets).toHaveLength(2);
    expect(body.data.assets[0].availableBalance).toBe('260.0000');
    expect(typeof body.meta.ts).toBe('number');
    expect(body.meta.stale).toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it('serves the second request within the TTL from cache (one Gate call)', async () => {
    app = makeTestApp();
    const scope = mockGateGet('/accounts', { fixture: 'account.json' }); // exactly one interceptor

    const first = await app.inject({ method: 'GET', url: '/api/account', headers: HOST });
    const second = await app.inject({ method: 'GET', url: '/api/account', headers: HOST });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.marginBalance).toBe('993.4877');
    expect(scope.isDone()).toBe(true);
  });

  it('estimates current interest using only account and rate reads', async () => {
    app = makeTestApp();
    const account = mockGateGet('/accounts', { body: { assets: [
      { coin: 'USDT', exchange_type: 'CROSSEX', liability: '2000' },
      { coin: 'USDC', exchange_type: 'HYPERLIQUID', liability: '12000' },
    ] } });
    const rates = mockGateGet('/interest_rate', { body: [
      { coin: 'USDT', exchange_type: 'CROSSEX', hour_interest_rate: '0.00001' },
      { coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.00002' },
    ] });
    // No mocks for fees, tickers, transfers or historical interest: these must not be read.
    const res = await app.inject({ method: 'GET', url: '/api/account/interest?fresh=1', headers: HOST });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.buckets[0].interestPerDayUsd).toBeCloseTo(0.48);
    expect(body.data.buckets[1].interestPerDayUsd).toBeCloseTo(0.96);
    expect(body.meta.stale).toBeUndefined();
    expect(account.isDone() && rates.isDone()).toBe(true);
  });

  it.each([undefined, '', 'bad'])('preserves invalid hourly rate %s for the monitor', async (hourly) => {
    app = makeTestApp();
    mockGateGet('/accounts', { body: { assets: [{ coin: 'USDT', exchange_type: 'CROSSEX', liability: '2000' }] } });
    mockGateGet('/interest_rate', { body: [{ coin: 'USDT', exchange_type: 'CROSSEX', hour_interest_rate: hourly }] });
    const res = await app.inject({ method: 'GET', url: '/api/account/interest?fresh=1', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.buckets[0].ratePerYear).toBeNull();
  });

  it('keeps account data when interest rates are unavailable', async () => {
    app = makeTestApp();
    mockGateGet('/accounts', { fixture: 'account.json' });
    mockGateGet('/interest_rate', { status: 500, body: { label: 'INTERNAL_SERVER_ERROR' } });
    const res = await app.inject({ method: 'GET', url: '/api/account/interest?fresh=1', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.account.marginBalance).toBe('993.4877');
    expect(res.json().data.buckets).toBeNull();
    expect(res.json().meta.stale).toBeUndefined();
  });

  it('reports the nearest absolute liquidation move across coins', async () => {
    app = makeTestApp();
    vi.spyOn(positionRoutes, 'marginTiersFor').mockResolvedValue({});
    mockGateGet('/accounts', { body: {
      margin_balance: '200', maintenance_margin: '20',
      assets: [{ coin: 'USDT', exchange_type: 'CROSSEX', equity: '200' }],
    } });
    mockGateGet('/positions', { body: [
      { symbol: 'BINANCE_FUTURE_ETH_USDT', position_qty: '1', position_side: 'LONG', position_value: '1000', mark_price: '1000', maintenance_margin: '10' },
      { symbol: 'BINANCE_FUTURE_BTC_USDT', position_qty: '-1', position_side: 'SHORT', position_value: '2000', mark_price: '2000', maintenance_margin: '10' },
    ] });
    const res = await app.inject({ method: 'GET', url: '/api/account/liquidation?fresh=1', headers: HOST });
    expect(res.statusCode).toBe(200);
    const { distance, view, assumptions } = res.json().data;
    expect(view.lines).toHaveLength(2);
    expect(view.lines.find((l: { base: string }) => l.base === 'ETH').move).toBeLessThan(0);
    expect(view.lines.find((l: { base: string }) => l.base === 'BTC').move).toBeGreaterThan(0);
    expect(distance).toBeCloseTo(Math.min(...view.lines.map((l: { move: number }) => Math.abs(l.move))));
    expect(distance).toBeCloseTo(180 / 2010);
    expect(assumptions).toContain('One coin moves at a time');
  });

  it.each(['mark_price', 'maintenance_margin', 'position_qty'])('keeps distance unknown when a position lacks %s', async (field) => {
    app = makeTestApp();
    vi.spyOn(positionRoutes, 'marginTiersFor').mockResolvedValue({});
    mockGateGet('/accounts', { body: {
      margin_balance: '200', maintenance_margin: '10',
      assets: [{ coin: 'USDT', exchange_type: 'CROSSEX', equity: '200' }],
    } });
    const position: Record<string, string | undefined> = {
      symbol: 'BINANCE_FUTURE_ETH_USDT', position_qty: '1', position_value: '1000',
      mark_price: '1000', maintenance_margin: '10',
    };
    position[field] = undefined;
    mockGateGet('/positions', { body: [position] });
    const res = await app.inject({ method: 'GET', url: '/api/account/liquidation?fresh=1', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.distance).toBeNull();
  });

  it('does not invent a finite distance for an account with no positions', async () => {
    app = makeTestApp();
    vi.spyOn(positionRoutes, 'marginTiersFor').mockResolvedValue({});
    mockGateGet('/accounts', { body: { margin_balance: '200', maintenance_margin: '0', assets: [] } });
    mockGateGet('/positions', { body: [] });
    const res = await app.inject({ method: 'GET', url: '/api/account/liquidation?fresh=1', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.distance).toBeNull();
  });
});
