import nock from 'nock';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOfficialFundingCatalog } from '../../src/core/funding/official-catalog';

beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });
const rule = (symbol: string) => ({ symbol, exchangeType: symbol.split('_')[0]!, businessType: 'FUTURE', state: 'live', delistTime: '0' });

it('reads official listing metadata without backdating today\'s funding interval', async () => {
  nock('https://fapi.binance.com').get('/fapi/v1/exchangeInfo').reply(200, { symbols: [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', onboardDate: 1_600_000_000_000 },
  ] });
  const catalog = createOfficialFundingCatalog({ rules: async () => [rule('BINANCE_FUTURE_BTC_USDT')] });
  expect((await catalog.contracts()).listings).toMatchObject([{ contractId: 'BTCUSDT', underlying: { id: 'BTC' } }]);
  expect(catalog.historyContext('BINANCE', 'BTCUSDT')).toMatchObject({ listing: { at: 1_600_000_000_000 } });
});

it('corroborates venue-native ids including paged Bybit listings and rejects missing or inverse products', async () => {
  const listed = '1600000000000';
  nock('https://fapi.asterdex.com').get('/fapi/v3/exchangeInfo').reply(200, { symbols: [
    { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' },
  ] });
  nock('https://www.okx.com').get('/api/v5/public/instruments').query({ instType: 'SWAP' }).reply(200, { code: '0', data: [
    { instId: 'BTC-USDT-SWAP', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', ctValCcy: 'BTC', state: 'live', listTime: listed },
    { instId: 'ETH-USD-SWAP', instType: 'SWAP', ctType: 'inverse', settleCcy: 'ETH', ctValCcy: 'USD', state: 'live', listTime: listed },
  ] });
  const bybit = (baseCoin: string) => ({ symbol: `${baseCoin}USDT`, baseCoin, quoteCoin: 'USDT', settleCoin: 'USDT',
    status: 'Trading', contractType: 'LinearPerpetual', launchTime: listed });
  nock('https://api.bybit.com').get('/v5/market/instruments-info').query({ category: 'linear', limit: 1000 })
    .reply(200, { retCode: 0, result: { list: [bybit('BTC')], nextPageCursor: 'second' } });
  nock('https://api.bybit.com').get('/v5/market/instruments-info').query({ category: 'linear', limit: 1000, cursor: 'second' })
    .reply(200, { retCode: 0, result: { list: [bybit('ETH')], nextPageCursor: '' } });
  nock('https://api.hyperliquid.xyz').post('/info', { type: 'meta' }).reply(200, { universe: [
    { name: 'BTC', szDecimals: 5 }, { name: 'ETH', szDecimals: 4, isDelisted: true },
  ] });
  const symbols = ['ASTER_FUTURE_ETH_USDT', 'OKX_FUTURE_BTC_USDT', 'OKX_FUTURE_ETH_USD',
    'BYBIT_FUTURE_BTC_USDT', 'BYBIT_FUTURE_ETH_USDT', 'HYPERLIQUID_FUTURE_BTC_USDC', 'HYPERLIQUID_FUTURE_ETH_USDC'];
  const catalog = createOfficialFundingCatalog({ rules: async () => symbols.map(rule) });
  const result = await catalog.contracts();
  expect(result.listings.map((l) => l.contractId).sort()).toEqual(['BTC', 'BTC-USDT-SWAP', 'BTCUSDT', 'ETHUSDT', 'ETHUSDT']);
  expect(result.rejected.map((r) => r.symbol).sort()).toEqual(['HYPERLIQUID_FUTURE_ETH_USDC', 'OKX_FUTURE_ETH_USD']);
  expect(catalog.historyContext('ASTER', 'ETHUSDT')).toEqual({ listing: null });
  expect(catalog.historyContext('OKX', 'BTC-USDT-SWAP')).toMatchObject({ listing: { at: Number(listed) } });
  expect(catalog.historyContext('HYPERLIQUID', 'BTC')).toEqual({ listing: null });
});

it('isolates a failed venue and never accepts a truncated or cyclic native catalog', async () => {
  nock('https://api.bybit.com').get('/v5/market/instruments-info').query(true).reply(200, {
    retCode: 0, result: { list: [], nextPageCursor: 'stuck' },
  });
  nock('https://www.okx.com').get('/api/v5/public/instruments').query(true).reply(200, { code: '0', data: [
    { instId: 'BTC-USDT-SWAP', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', ctValCcy: 'BTC', state: 'live', listTime: '1600000000000' },
  ] });
  const catalog = createOfficialFundingCatalog({ rules: async () => [rule('BYBIT_FUTURE_BTC_USDT'), rule('OKX_FUTURE_BTC_USDT')] });
  const result = await catalog.contracts();
  expect(result.listings.map((l) => l.venue)).toEqual(['OKX']);
  expect(result.rejected).toEqual([{ symbol: 'BYBIT_FUTURE_BTC_USDT', reason: 'native-source-failed' }]);
  expect(catalog.historyContext('BYBIT', 'BTCUSDT')).toBeNull();
});
