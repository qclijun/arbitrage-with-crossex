import { expect, it } from 'vitest';
import { mapFundingContracts, type NativeFundingContract } from '../../src/core/funding/contract-identity';

const rule = (symbol: string, exchangeType = symbol.split('_')[0]) =>
  ({ symbol, exchangeType, businessType: 'FUTURE', state: 'live', delistTime: '0' });
const btc: NativeFundingContract = { venue: 'BINANCE', contractId: 'BTCUSDT', base: 'BTC', quote: 'USDT',
  linear: true, live: true, listing: { at: 1_600_000_000_000, evidence: 'official onboardDate' }, evidence: 'official instrument fixture' };

it('binds an exact live CrossEx rule to a corroborated native contract and evidenced economic identity', () => {
  const result = mapFundingContracts([rule('BINANCE_FUTURE_BTC_USDT')], [btc]);
  expect(result.rejected).toEqual([]);
  expect(result.listings).toMatchObject([{ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', contractId: 'BTCUSDT',
    underlying: { id: 'BTC', evidence: expect.stringContaining('https://') },
    rateBasis: { id: 'linear-mark-notional-fraction', evidence: expect.stringContaining('https://') } }]);
});

it('keeps an unreviewed ticker observable but never treats an alias as economic proof', () => {
  const native = { ...btc, base: '1000PEPE', contractId: '1000PEPEUSDT' };
  const result = mapFundingContracts([rule('BINANCE_FUTURE_1000PEPE_USDT')], [native]);
  expect(result.listings).toMatchObject([{ contractId: '1000PEPEUSDT', mappingEvidence: expect.stringContaining('official instrument fixture'), underlying: null, rateBasis: { id: 'linear-mark-notional-fraction' } }]);
});

it.each([
  ['venue conflict', [rule('BINANCE_FUTURE_BTC_USDT', 'OKX')], [btc]],
  ['wrong native id', [rule('BINANCE_FUTURE_BTC_USDT')], [{ ...btc, contractId: 'BTCUSDC' }]],
  ['inverse', [rule('BINANCE_FUTURE_BTC_USDT')], [{ ...btc, linear: false }]],
  ['duplicate native identity', [rule('BINANCE_FUTURE_BTC_USDT')], [btc, btc]],
  ['duplicate CrossEx symbol', [rule('BINANCE_FUTURE_BTC_USDT'), rule('BINANCE_FUTURE_BTC_USDT')], [btc]],
  ['alias', [rule('BINANCE_FUTURE_XBT_USDT')], [btc]],
] as const)('refuses %s instead of choosing an arbitrary leg', (_name, rules, native) => {
  const result = mapFundingContracts([...rules], [...native]);
  expect(result.listings).toEqual([]);
  expect(result.rejected.length).toBeGreaterThan(0);
});

it('keeps HL economic identity unproved while exposing its distinct oracle basis', () => {
  const native = [{ ...btc, venue: 'OKX', contractId: 'BTC-USDT-SWAP' },
    { ...btc, venue: 'HYPERLIQUID', contractId: 'BTC', quote: 'USDC' }];
  const result = mapFundingContracts([rule('OKX_FUTURE_BTC_USDT'), rule('HYPERLIQUID_FUTURE_BTC_USDC')], native);
  expect(result.listings.map((l) => l.underlying?.id)).toEqual(['BTC', undefined]);
  expect(result.listings.map((l) => l.rateBasis?.id)).toEqual(['linear-mark-notional-fraction', 'linear-oracle-notional-fraction']);
});

it('uses Aster\'s documented mark-price position-notional basis for an exact reviewed BTC product', () => {
  const result = mapFundingContracts([rule('ASTER_FUTURE_BTC_USDT')], [{ ...btc, venue: 'ASTER' }]);
  expect(result.listings[0]?.rateBasis).toMatchObject({ id: 'linear-mark-notional-fraction', evidence: expect.stringContaining('funding-rate') });
});


it('does not upgrade a familiar ticker to economic proof without a reviewed exact-product entry', () => {
  const result = mapFundingContracts([rule('BINANCE_FUTURE_HYPE_USDT'), rule('ASTER_FUTURE_BTC_USDT')],
    [{ ...btc, base: 'HYPE', contractId: 'HYPEUSDT' }, { ...btc, venue: 'ASTER' }]);
  expect(result.listings.map((l) => l.underlying)).toEqual([null, null]);
});
