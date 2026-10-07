import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateLiquidityMetrics } from '../../src/core/boros/liquidity-metrics';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

let app: FastifyInstance;
afterEach(async () => { await app?.close(); vi.useRealTimers(); });
function setup(long: unknown, short: unknown, asset: Record<string, unknown> = {}) {
  app = makeTestApp({ borosFetch: borosStub({
    '/apis/v1/markets': { results: [{ marketId: 197, tokenId: 2,
      platform: { platformId: 'Binance', name: 'Binance' },
      metadata: { name: 'ETHUSDT', underlyingSymbol: 'ETH' }, imData: { maturity: 1793318400 },
      data: { volume24h: 123.5, notionalOI: 600.25 },
    }], resumeToken: null },
    '/apis/v1/assets': { results: [{ tokenId: 2, id: 'ETH', symbol: 'WETH', decimals: 18, usdPrice: 2000, ...asset }] },
    '/apis/v1/markets/order-book?marketId=197': { long, short },
  }) });
}
const read = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/boros/liquidity', headers: HOST });
  expect(res.statusCode).toBe(200);
  return res.json().data.markets[0];
};

describe('Boros liquidity metrics through the public snapshot API', () => {
  it('computes aggregated APR spread and exact visible YU without deriving volume or OI from depth', async () => {
    setup({ ia: [40, 50], sz: ['2000000000000000000', '1000000000000000001'] },
      { ia: [80, 70], sz: ['4000000000000000000', '3000000000000000000'] });
    const snapshot = await read();
    const metrics = snapshot.metrics;
    expect(metrics.bestBidApr.value).toBe(0.005);
    expect(metrics.bestAskApr.value).toBe(0.007);
    expect(metrics.midApr.value).toBe(0.006);
    expect(metrics.spreadApr.value).toBe(0.002);
    expect(metrics.spreadPp.value).toBe(0.2);
    expect(metrics.spreadAprBp.value).toBe(20);
    expect(metrics.crossed).toBe(false);
    expect(metrics.bids.visibleDepth.yu.value).toBe('3.000000000000000001');
    expect(metrics.asks.visibleDepth.yu.value).toBe('7');
    expect(metrics.bids.levelCount.value).toBe(2);
    expect(metrics.bids.farthestApr.value).toBe(0.004);
    expect(metrics.bids.visibleDepth.yu.completeness).toBe('partial');
    expect(metrics.bids.visibleDepth.collateralNotional).toMatchObject({ value: '3.000000000000000001', unit: 'WETH-notional' });
    expect(metrics.bids.visibleDepth.usdNotional.value).toBeNull();
    expect(metrics.bids.visibleDepth.usdNotional.reason).toContain('PRICE_SOURCE_TIME_UNKNOWN');
    expect(snapshot.volume24hYu.value).toBe(123.5);
    expect(snapshot.notionalOiOneSidedYu.value).toBe(600.25);
    expect(snapshot.oiConvention).toBe('one-sided');
  });

  it('includes each diagnostic endpoint relative to its own best with exact 18-decimal sums', async () => {
    const sizes = ['1000000000000000001', '2000000000000000000', '4000000000000000000', '8000000000000000000', '16000000000000000000'];
    setup({ ia: [0, -10, -25, -50, -51], sz: sizes },
      { ia: [5, 15, 30, 55, 56], sz: sizes }, { decimals: 6 });
    const metrics = (await read()).metrics;
    expect(metrics.bids.windows.map((w: any) => w.depth.yu.value)).toEqual(['3.000000000000000001', '7.000000000000000001', '15.000000000000000001']);
    expect(metrics.asks.windows.map((w: any) => w.depth.yu.value)).toEqual(['3.000000000000000001', '7.000000000000000001', '15.000000000000000001']);
    expect(metrics.bids.windows.map((w: any) => w.widthAprBp)).toEqual([10, 25, 50]);
    expect(metrics.bids.windows[0]).toMatchObject({ fromApr: -0.001, toApr: 0, endpointsInclusive: true, coverage: 'bounded-aggregation-window' });
    expect(metrics.asks.windows[0]).toMatchObject({ fromApr: 0.0005, toApr: 0.0015, endpointsInclusive: true });
    expect(metrics.asks.windows[2].depth.yu.completeness).toBe('complete');
    expect(metrics.bids.windows[0].depth.collateralNotional.value).toBe('3.000000000000000001');
    expect(metrics.midApr.value).toBe(0.00025);
    expect(metrics.spreadAprBp.value).toBe(5);
  });

  it('keeps negative APR and a zero mid valid without spot-relative division', async () => {
    setup({ ia: [-50, -60], sz: ['1', '2'] }, { ia: [50, 60], sz: ['3', '4'] });
    const metrics = (await read()).metrics;
    expect(metrics.bestBidApr.value).toBe(-0.005);
    expect(metrics.midApr.value).toBe(0);
    expect(metrics.spreadApr.value).toBe(0.01);
    expect(metrics.spreadPp.value).toBe(1);
    expect(metrics.spreadAprBp.value).toBe(100);
    expect(metrics.bids.windows[0].depth.yu.value).toBe('0.000000000000000003');
  });

  it('reports a crossed book with a signed negative spread rather than taking its absolute value', async () => {
    setup({ ia: [50], sz: ['1'] }, { ia: [20], sz: ['2'] });
    const metrics = (await read()).metrics;
    expect(metrics.crossed).toBe(true);
    expect(metrics.spreadApr.value).toBeCloseTo(-0.003, 12);
    expect(metrics.spreadPp.value).toBeCloseTo(-0.3, 12);
    expect(metrics.spreadAprBp.value).toBe(-30);
    expect(metrics.spreadApr.completeness).toBe('partial');
    expect(metrics.spreadApr.reason).toContain('CROSSED_BOOK');
  });

  it('marks complete zero visible depth but cannot invent best APR or a best-relative window', async () => {
    setup({ ia: [], sz: [] }, { ia: [], sz: [] });
    const metrics = (await read()).metrics;
    expect(metrics.bids.visibleDepth.yu).toMatchObject({ value: '0', completeness: 'complete' });
    expect(metrics.asks.visibleDepth.collateralNotional.value).toBe('0');
    expect(metrics.bids.levelCount.value).toBe(0);
    expect(metrics.bestBidApr.value).toBeNull();
    expect(metrics.midApr.value).toBeNull();
    expect(metrics.spreadApr.value).toBeNull();
    expect(metrics.bids.farthestApr.value).toBeNull();
    expect(metrics.bids.windows[0]).toMatchObject({ fromApr: null, toApr: null, coverage: 'unknown' });
    expect(metrics.bids.windows[0].depth.yu.value).toBeNull();
  });

  it('preserves valid one-sided values while a missing side and paired metrics remain UNKNOWN', async () => {
    setup(null, { ia: [0], sz: ['1000000000000000000'] });
    const metrics = (await read()).metrics;
    expect(metrics.bids.visibleDepth.yu.value).toBeNull();
    expect(metrics.bids.levelCount.value).toBeNull();
    expect(metrics.bids.windows[0].depth.yu.value).toBeNull();
    expect(metrics.asks.visibleDepth.yu.value).toBe('1');
    expect(metrics.bestAskApr.value).toBe(0);
    expect(metrics.midApr.value).toBeNull();
    expect(metrics.spreadApr.value).toBeNull();
  });

  it('does not mistake discarded invalid or duplicate levels for a complete empty book', async () => {
    setup({ ia: [0, 10.5, '20', 30], sz: ['-1', '1', '1', '0'] },
      { ia: [10, 10, 20, 21], sz: ['1', '2', '3', '4'] });
    const metrics = (await read()).metrics;
    expect(metrics.bids.visibleDepth.yu.value).toBeNull();
    expect(metrics.bestBidApr.value).toBeNull();
    expect(metrics.asks.visibleDepth.yu).toMatchObject({ value: '0.000000000000000008', completeness: 'partial' });
    expect(metrics.bestAskApr.completeness).toBe('partial');
    expect(metrics.asks.windows[0].depth.yu).toMatchObject({ value: '0.000000000000000004', completeness: 'partial' });
    expect(metrics.asks.windows[0].coverage).toBe('partial');
    expect(metrics.asks.windows[0].depth.yu.reason).toContain('INVALID_OR_DUPLICATE_LEVELS');
  });

  it('distinguishes windows beyond the cap from windows fully covered by a returned tail', async () => {
    const indices = Array.from({ length: 50 }, (_, i) => i);
    indices[49] = 50; // A tail exactly on the inclusive endpoint does not prove coverage beyond it.
    setup({ ia: indices.map(i => -i), sz: indices.map(() => '1') }, { ia: indices, sz: indices.map(() => '1') });
    const metrics = (await read()).metrics;
    expect(metrics.asks.visibleDepth.yu).toMatchObject({ value: '0.00000000000000005', completeness: 'partial' });
    expect(metrics.asks.windows.map((w: any) => w.depth.yu.value)).toEqual(['0.000000000000000011', '0.000000000000000026', '0.00000000000000005']);
    expect(metrics.asks.windows[0]).toMatchObject({ coverage: 'bounded-aggregation-window' });
    expect(metrics.asks.windows[1].depth.yu.completeness).toBe('complete');
    expect(metrics.asks.windows[2]).toMatchObject({ coverage: 'lower-bound' });
    expect(metrics.asks.windows[2].depth.yu.completeness).toBe('partial');
    expect(metrics.asks.windows[2].depth.yu.reason).toContain('WINDOW_DEPTH_LOWER_BOUND');
    expect(metrics.bids.windows[2].depth.yu.value).toBe('0.00000000000000005');
  });

  it('does not promote a client-truncated contract violation into a complete window', async () => {
    const indices = Array.from({ length: 51 }, (_, i) => i);
    setup({ ia: indices.map(i => -i), sz: indices.map(() => '1') }, { ia: indices, sz: indices.map(() => '1') });
    const metrics = (await read()).metrics;
    expect(metrics.asks.levelCount.value).toBe(50);
    expect(metrics.asks.windows[0].coverage).toBe('partial');
    expect(metrics.asks.windows[0].depth.yu.completeness).toBe('partial');
    expect(metrics.asks.windows[0].depth.yu.reason).toContain('UPSTREAM_CAP_CONTRACT_VIOLATION');
  });

  it('does not claim full window coverage just because fewer than 50 levels were returned', async () => {
    setup({ ia: [0, -10], sz: ['1', '2'] }, { ia: [0, 10], sz: ['3', '4'] });
    const window = (await read()).metrics.bids.windows[0];
    expect(window.depth.yu.value).toBe('0.000000000000000003');
    expect(window.coverage).toBe('coverage-unknown');
    expect(window.depth.yu.completeness).toBe('partial');
    expect(window.depth.yu.reason).toContain('WINDOW_COVERAGE_UNKNOWN');
  });

  it('keeps units UNKNOWN without collateral identity and never assumes a stablecoin USD peg', async () => {
    setup({ ia: [0], sz: ['1000000000000000000'] }, { ia: [10], sz: ['1'] }, { id: null, symbol: 'USDT', usdPrice: 1 });
    const snapshot = await read();
    expect(snapshot.metrics.bids.visibleDepth.yu.value).toBe('1');
    expect(snapshot.metrics.bids.visibleDepth.collateralNotional.value).toBeNull();
    expect(snapshot.metrics.bids.visibleDepth.usdNotional.value).toBeNull();
    expect(snapshot.metrics.bids.visibleDepth.usdNotional.reason).toContain('PRICE_SOURCE_TIME_UNKNOWN');
  });

  it('propagates stale/missing source clocks into derived metrics instead of restamping now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1791353456000);
    setup({ ia: [0], sz: ['1'] }, { ia: [10], sz: ['2'] });
    const snapshot = await read();
    // Calculation is a pure public boundary: a later invocation must retain
    // the snapshot evidence as presented, including an explicit stale marker.
    snapshot.book.bids.freshness = 'stale';
    snapshot.book.bids.reason.push('STALE', 'REQUEST_FAILED:network');
    vi.setSystemTime(1791353556000);
    const metrics = calculateLiquidityMetrics(snapshot.book, snapshot.collateral);
    expect(metrics.spreadApr.collectedAt).toBe(1791353456000);
    expect(metrics.spreadApr.sourceObservedAt).toBeNull();
    expect(metrics.spreadApr.freshness).toBe('stale');
    expect(metrics.spreadApr.reason).toContain('REQUEST_FAILED:network');
    expect(metrics.spreadApr.inputs[0].source).toContain('#long');
    expect(metrics.spreadApr.inputs[1].source).toContain('#short');
  });
});
