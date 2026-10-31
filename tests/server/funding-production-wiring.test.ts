import nock from 'nock';
import { afterEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createOfficialFundingCatalog } from '../../src/core/funding/official-catalog';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { createFundingServices } from '../../src/server/funding/services';
import { HOST, makeTestApp } from './helpers/gate-nock';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const rule = (symbol: string) => ({ symbol, exchangeType: symbol.split('_')[0]!, businessType: 'FUTURE', state: 'live', delistTime: '0' });
const H = 3_600_000;
const settled = (query: Record<string, unknown>) => {
  const out: number[] = [];
  for (let t = Math.ceil(Number(query.startTime) / (8 * H)) * 8 * H; t <= Number(query.endTime); t += 8 * H) out.push(t);
  return out;
};

it('ranks real mapped candidates on settled history proved against the current interval; rejected mappings stay explicit', async () => {
  const catalog = createOfficialFundingCatalog({ rules: async () => [
    rule('BINANCE_FUTURE_BTC_USDT'), rule('BYBIT_FUTURE_BTC_USDT'), rule('BINANCE_FUTURE_XBT_USDT'), rule('BINANCE_FUTURE_ETH_USDT'),
  ] });
  nock('https://fapi.binance.com').get('/fapi/v1/exchangeInfo').reply(200, { symbols: [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', onboardDate: 1_600_000_000_000 },
    { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', onboardDate: 1_600_000_000_000 },
  ] });
  nock('https://api.bybit.com').get('/v5/market/instruments-info').query(true).reply(200, { retCode: 0, result: { list: [
    { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', status: 'Trading', contractType: 'LinearPerpetual', launchTime: '1600000000000' },
  ], nextPageCursor: '' } });
  nock('https://fapi.binance.com').get('/fapi/v1/premiumIndex').reply(200, [
    { symbol: 'BTCUSDT', lastFundingRate: '0.0001' },
    { symbol: 'ETHUSDT', lastFundingRate: '0.0001' },
  ]).get('/fapi/v1/fundingInfo').reply(200, []);
  nock('https://api.bybit.com').get('/v5/market/tickers').query({ category: 'linear' }).reply(200, { result: { list: [
    { symbol: 'BTCUSDT', fundingRate: '0.0002', fundingIntervalHour: '8' },
  ] } });
  const binanceHistorySymbols = new Set<string>();
  nock('https://fapi.binance.com').persist().get('/fapi/v1/fundingRate').query(true).reply(200, (uri) => {
    const query = Object.fromEntries(new URL(uri, 'https://fapi.binance.com').searchParams);
    binanceHistorySymbols.add(String(query.symbol));
    return settled(query).slice(0, 1000).map((fundingTime) => ({ symbol: 'BTCUSDT', fundingTime, fundingRate: '0.0003' }));
  });
  nock('https://api.bybit.com').persist().get('/v5/market/funding/history').query(true).reply(200, (uri) => {
    const query = Object.fromEntries(new URL(uri, 'https://api.bybit.com').searchParams);
    return { retCode: 0, result: { list: settled(query).reverse().slice(0, 200)
      .map((t) => ({ symbol: 'BTCUSDT', fundingRateTimestamp: String(t), fundingRate: '0.0001' })) } };
  });
  const services = createFundingServices({ contracts: catalog.contracts,
    sources: createOfficialHistorySources({ context: (venue, id) => catalog.historyContext(venue, id) }) });
  await services.runOnce();
  expect(services.funding.legOf('BINANCE_FUTURE_BTC_USDT')).toEqual({ venue: 'BINANCE', contractId: 'BTCUSDT' });
  expect(services.funding.legOf('BINANCE_FUTURE_XBT_USDT')).toBeNull();
  app = makeTestApp({ opportunities: services.opportunities, funding: services.funding });
  expect(nock.isDone()).toBe(true);
  expect([...binanceHistorySymbols]).toEqual(['BTCUSDT']);
  for (let i = 0; i < 2; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/api/funding/opportunities?days=7', headers: HOST });
    expect(res.statusCode).toBe(200);
    const board = res.json().data;
    expect(board).toMatchObject({ candidateCount: 2, rankedCount: 2, admission: { open: false },
      contracts: { state: 'ready', count: 3, rejected: [{ symbol: 'BINANCE_FUTURE_XBT_USDT', reason: 'native-contract-unverified' }] } });
    expect(board.rows[0].windows[0]).toMatchObject({ eligible: true, coverage: 'complete',
      legs: { short: { lastAttempt: { outcome: 'success' } }, long: { lastAttempt: { outcome: 'success' } } } });
  }
});
