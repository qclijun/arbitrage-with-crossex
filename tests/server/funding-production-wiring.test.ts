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

it('keeps mapped candidates UNKNOWN when cadence samples are insufficient and mapping refusals explicit', async () => {
  const catalog = createOfficialFundingCatalog({ rules: async () => [
    rule('BINANCE_FUTURE_BTC_USDT'), rule('BYBIT_FUTURE_BTC_USDT'), rule('BINANCE_FUTURE_XBT_USDT'),
  ] });
  nock('https://fapi.binance.com').get('/fapi/v1/exchangeInfo').reply(200, { symbols: [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', onboardDate: 1_600_000_000_000 },
  ] });
  nock('https://api.bybit.com').get('/v5/market/instruments-info').query(true).reply(200, { retCode: 0, result: { list: [
    { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', status: 'Trading', contractType: 'LinearPerpetual', launchTime: '1600000000000' },
  ], nextPageCursor: '' } });
  nock('https://fapi.binance.com').get('/fapi/v1/premiumIndex').reply(200, [
    { symbol: 'BTCUSDT', lastFundingRate: '0.0001' },
  ]).get('/fapi/v1/fundingInfo').reply(200, []);
  nock('https://api.bybit.com').get('/v5/market/tickers').query({ category: 'linear' }).reply(200, { result: { list: [
    { symbol: 'BTCUSDT', fundingRate: '0.0002', fundingIntervalHour: '8' },
  ] } });
  const cutoff = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  nock('https://fapi.binance.com').persist().get('/fapi/v1/fundingRate').query(true).reply(200, (uri) => {
    const query = new URL(uri, 'https://fapi.binance.com').searchParams;
    return Number(query.get('endTime')) === cutoff + 999 ? [{ symbol: 'BTCUSDT', fundingTime: cutoff, fundingRate: '0.0001' }] : [];
  });
  nock('https://api.bybit.com').persist().get('/v5/market/funding/history').query(true).reply(200, (uri) => {
    const query = new URL(uri, 'https://api.bybit.com').searchParams;
    return { retCode: 0, result: { list: Number(query.get('endTime')) === cutoff
      ? [{ symbol: 'BTCUSDT', fundingRateTimestamp: String(cutoff), fundingRate: '0.0002' }] : [] } };
  });
  const services = createFundingServices({ contracts: catalog.contracts,
    sources: createOfficialHistorySources({ context: (venue, id) => catalog.historyContext(venue, id) }) });
  await services.runOnce();
  expect(services.funding.legOf('BINANCE_FUTURE_BTC_USDT')).toEqual({ venue: 'BINANCE', contractId: 'BTCUSDT' });
  expect(services.funding.legOf('BINANCE_FUTURE_XBT_USDT')).toBeNull();
  app = makeTestApp({ opportunities: services.opportunities, funding: services.funding });
  expect(nock.isDone()).toBe(true);
  for (let i = 0; i < 2; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/api/funding/opportunities?days=7', headers: HOST });
    expect(res.statusCode).toBe(200);
    const board = res.json().data;
    expect(board).toMatchObject({ candidateCount: 2, rankedCount: 0, admission: { open: false },
      contracts: { state: 'ready', count: 2, rejected: [{ symbol: 'BINANCE_FUTURE_XBT_USDT', reason: 'native-contract-unverified' }] } });
    expect(board.rows[0].windows[0]).toMatchObject({ eligible: false, legs: {
      short: { lastAttempt: { outcome: 'success' }, reasons: expect.arrayContaining(['cadence-sample-insufficient']) },
      long: { lastAttempt: { outcome: 'success' }, reasons: expect.arrayContaining(['cadence-sample-insufficient']) },
    } });
  }
  const response = await app.inject({ method: 'GET', url: '/api/funding/settlements?underlying=BTC', headers: HOST });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.rows).toMatchObject([
    { venue: 'BINANCE', windows: expect.arrayContaining([expect.objectContaining({ days: 7, coverage: 'unknown', annualized: null,
      observed: expect.objectContaining({ total: '0.0001', events: 1 }) })]) },
    { venue: 'BYBIT', windows: expect.arrayContaining([expect.objectContaining({ days: 7, coverage: 'unknown', annualized: null,
      observed: expect.objectContaining({ total: '0.0002', events: 1 }) })]) },
  ]);
});
