import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const rule = (symbol: string) => ({
  symbol,
  exchange_type: symbol.split('_')[0],
  business_type: 'FUTURE',
  state: 'live',
  delist_time: '0',
  min_size: '1',
  lot_size: '1',
  tick_size: '0.1',
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/funding-spreads', () => {
  it('pairs venues off their public feeds, names a failed feed, and assumes VIP 0 without fees', async () => {
    mockGateGet('/rule/symbols', {
      body: [
        rule('GATE_FUTURE_DOGE_USDT'),
        rule('HYPERLIQUID_FUTURE_DOGE_USDC'),
        rule('OKX_FUTURE_DOGE_USDT'),
        rule('KRAKEN_FUTURE_DOGE_USD'),
        // No funding feed is wired for Deribit: listed, so it must read as missing.
        rule('DERIBIT_FUTURE_DOGE_USDC'),
        // A USDC twin on a CEX is a separate book the USDT feed does not price.
        rule('GATE_FUTURE_DOGE_USDC'),
      ],
    });
    mockGateGet('/fee', { status: 500, body: { label: 'SERVER_ERROR' } });
    nock('https://api.gateio.ws')
      .get('/api/v4/futures/usdt/contracts')
      .reply(200, [{ name: 'DOGE_USDT', funding_rate: '0.0003', funding_interval: 28_800, mark_price: '0.2' }]);
    nock('https://api.hyperliquid.xyz')
      .post('/info', { type: 'metaAndAssetCtxs' })
      .reply(200, [{ universe: [{ name: 'DOGE' }] }, [{ funding: '-0.00001', markPx: '0.2001' }]]);
    nock('https://www.okx.com').get('/api/v5/public/funding-rate').query({ instId: 'ANY' }).reply(503, {});
    // A 200 that prices nothing is a broken feed, not a venue with no contracts.
    nock('https://futures.kraken.com').get('/derivatives/api/v3/tickers').reply(200, { tickers: [] });

    app = makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/funding-spreads', headers: HOST });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.coverageComplete).toBe(false);
    expect(body.meta.stale).toBeUndefined();
    expect(typeof body.meta.observedAt).toBe('number');
    const { rows, feeds, assumedFeeTier } = body.data;
    expect(assumedFeeTier).toBe('vip0');
    expect(feeds.map((f: { venue: string; ok: boolean; error: string | null }) => [f.venue, f.ok, f.error])).toEqual([
      ['DERIBIT', false, 'no-feed'],
      ['GATE', true, null],
      ['HYPERLIQUID', true, null],
      ['KRAKEN', false, 'empty'],
      ['OKX', false, 'unknown'],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      underlying: 'DOGE',
      short: { venue: 'GATE', symbol: 'GATE_FUTURE_DOGE_USDT' },
      long: { venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_DOGE_USDC' },
      priceMismatch: false,
      unquotedVenues: ['DERIBIT', 'KRAKEN', 'OKX'],
    });
    expect(rows[0].spreadApr).toBeCloseTo(0.0003 * 3 * 365 + 0.00001 * 8760);
    expect(rows[0].paybackDays).toBeGreaterThan(0);
  });
});
