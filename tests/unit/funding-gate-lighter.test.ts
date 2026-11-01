import nock from 'nock';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOfficialFundingCatalog } from '../../src/core/funding/official-catalog';
import { enumerateFundingCandidates } from '../../src/core/funding/ranking';
import { nativeFundingListings } from '../helpers/funding-hyperliquid-fixture';

beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });
const rule = (symbol: string) => ({ symbol, exchangeType: symbol.split('_')[0]!, businessType: 'FUTURE', state: 'live', delistTime: '0' });

// Trimmed from GET /api/v4/futures/usdt/contracts and GET /api/v1/orderBooks (2026-11-01).
const gate = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'direct', quanto_multiplier: '0.0001',
  funding_interval: 28_800, funding_rate: '0.000072', create_time: 1_574_035_200, status: 'trading', in_delisting: false, ...extra });
const lighter = (symbol: string, extra: Record<string, unknown> = {}) => ({ symbol, market_id: 1, market_type: 'perp',
  status: 'active', is_frozen: false, created_at: '1737098461107', multiplier: '1.000000000000000000', ...extra });

function mockVenues() {
  nock('https://api.gateio.ws').get('/api/v4/futures/usdt/contracts').reply(200, [
    gate('BTC_USDT'), gate('ETH_USDT'), gate('OLD_USDT', { in_delisting: true }), gate('BTC_USD', { type: 'inverse' }),
  ]);
  nock('https://mainnet.zklighter.elliot.ai').get('/api/v1/orderBooks').reply(200, { code: 200, order_books: [
    lighter('BTC'), lighter('ETH', { market_id: 0 }), lighter('ETH/USDC', { market_type: 'spot' }), lighter('ICE', { is_frozen: true }),
  ] });
}

it('corroborates Gate USDT and Lighter perps from their official instrument lists, excluding spot, frozen and delisting rows', async () => {
  mockVenues();
  const symbols = ['GATE_FUTURE_BTC_USDT', 'GATE_FUTURE_ETH_USDT', 'GATE_FUTURE_OLD_USDT',
    'LIGHTER_FUTURE_BTC_USDC', 'LIGHTER_FUTURE_ETH_USDC', 'LIGHTER_FUTURE_ICE_USDC'];
  const catalog = createOfficialFundingCatalog({ rules: async () => symbols.map(rule) });
  const result = await catalog.contracts();
  expect(result.listings.map((l) => `${l.venue}:${l.contractId}`).sort())
    .toEqual(['GATE:BTC_USDT', 'GATE:ETH_USDT', 'LIGHTER:BTC', 'LIGHTER:ETH']);
  expect(result.rejected.map((r) => r.symbol).sort()).toEqual(['GATE_FUTURE_OLD_USDT', 'LIGHTER_FUTURE_ICE_USDC']);
  // Gate writes listing time in seconds; Lighter in milliseconds.
  expect(catalog.historyContext('GATE', 'BTC_USDT')).toMatchObject({ listing: { at: 1_574_035_200_000 } });
  expect(catalog.historyContext('LIGHTER', 'BTC')).toMatchObject({ listing: { at: 1_737_098_461_107 } });
});

it('proves BTC/ETH identity for both venues with Gate on the mark basis and Lighter on its own index basis', async () => {
  mockVenues();
  const catalog = createOfficialFundingCatalog({ rules: async () =>
    ['GATE_FUTURE_BTC_USDT', 'GATE_FUTURE_ETH_USDT', 'LIGHTER_FUTURE_BTC_USDC', 'LIGHTER_FUTURE_ETH_USDC'].map(rule) });
  const { listings } = await catalog.contracts();
  expect(listings.map((l) => [l.venue, l.underlying?.id, l.rateBasis?.id])).toEqual([
    ['GATE', 'BTC', 'linear-mark-notional-fraction'], ['GATE', 'ETH', 'linear-mark-notional-fraction'],
    ['LIGHTER', 'BTC', 'linear-index-notional-fraction'], ['LIGHTER', 'ETH', 'linear-index-notional-fraction'],
  ]);
  expect(listings.every((l) => l.underlying!.evidence.includes('https://') && /^https:\/\//.test(l.rateBasis!.evidence))).toBe(true);
});

it('reports a Lighter API error as a failed native source rather than an unwired one', async () => {
  nock('https://mainnet.zklighter.elliot.ai').get('/api/v1/orderBooks').reply(200, { code: 500, message: 'down' });
  const catalog = createOfficialFundingCatalog({ rules: async () => [rule('LIGHTER_FUTURE_BTC_USDC')] });
  expect((await catalog.contracts()).rejected).toEqual([{ symbol: 'LIGHTER_FUTURE_BTC_USDC', reason: 'native-source-failed' }]);
});

it.each(['BTC', 'ETH'] as const)('pairs Gate and Lighter %s with every venue, estimating only across price bases', async (coin) => {
  mockVenues();
  const catalog = createOfficialFundingCatalog({ rules: async () =>
    [`GATE_FUTURE_${coin}_USDT`, `LIGHTER_FUTURE_${coin}_USDC`].map(rule) });
  const result = enumerateFundingCandidates([...nativeFundingListings(coin), ...(await catalog.contracts()).listings]);
  expect(result.unpaired).toEqual([]);
  expect(result.candidates).toHaveLength(30);
  const pair = (s: string, l: string) => result.candidates.find((c) => c.short.venue === s && c.long.venue === l);
  expect(pair('GATE', 'BINANCE')).not.toHaveProperty('rateEstimate');
  expect(pair('GATE', 'HYPERLIQUID')?.rateEstimate).toEqual({ short: { price: 'mark', settlement: 'USDT' }, long: { price: 'oracle', settlement: 'USDC' } });
  expect(pair('LIGHTER', 'OKX')?.rateEstimate).toEqual({ short: { price: 'index', settlement: 'USDC' }, long: { price: 'mark', settlement: 'USDT' } });
  expect(pair('HYPERLIQUID', 'LIGHTER')?.rateEstimate).toEqual({ short: { price: 'oracle', settlement: 'USDC' }, long: { price: 'index', settlement: 'USDC' } });
});
