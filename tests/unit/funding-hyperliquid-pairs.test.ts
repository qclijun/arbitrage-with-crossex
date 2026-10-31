import { expect, it } from 'vitest';
import { enumerateFundingCandidates } from '../../src/core/funding/ranking';
import { nativeFundingListings } from '../helpers/funding-hyperliquid-fixture';

it.each(['BTC', 'ETH'] as const)('includes twelve distinct directed %s pairs and labels HL rate estimates', (coin) => {
  const listings = nativeFundingListings(coin);
  const result = enumerateFundingCandidates(listings);
  expect(result.unpaired).toEqual([]);
  expect(result.candidates).toHaveLength(12);
  expect(new Set(result.candidates.map((c) => c.id)).size).toBe(12);
  expect(result.candidates.every((c) => c.short.venue !== c.long.venue)).toBe(true);
  const forward = result.candidates.find((c) => c.short.venue === 'HYPERLIQUID' && c.long.venue === 'OKX');
  const reverse = result.candidates.find((c) => c.short.venue === 'OKX' && c.long.venue === 'HYPERLIQUID');
  expect(forward).toMatchObject({ underlying: coin, short: { contractId: coin }, long: { contractId: `${coin}-USDT-SWAP` },
    rateEstimate: { short: { price: 'oracle', settlement: 'USDC' }, long: { price: 'mark', settlement: 'USDT' } } });
  expect(reverse).toMatchObject({ rateEstimate: { short: { price: 'mark', settlement: 'USDT' }, long: { price: 'oracle', settlement: 'USDC' } } });
  expect(result.candidates.filter((c) => c.short.venue !== 'HYPERLIQUID' && c.long.venue !== 'HYPERLIQUID')
    .every((c) => !('rateEstimate' in c))).toBe(true);
});

it.each(['XBT', 'WBTC', 'kBTC', 'xyz:BTC', 'HYPE'])('does not promote %s into a reviewed native BTC/ETH pair', (asset) => {
  const supported = nativeFundingListings('BTC');
  const hl = supported.find((l) => l.venue === 'HYPERLIQUID')!;
  const wrong = { ...hl, contractId: asset, underlying: { id: 'BTC', evidence: 'claimed alias' } };
  const result = enumerateFundingCandidates([...supported.filter((l) => l !== hl), wrong]);
  expect(result.candidates).toHaveLength(6);
  expect(result.unpaired).toContainEqual({ venue: 'HYPERLIQUID', contractId: asset, reason: 'rate-basis-mismatch' });
});

it('does not pair an exact HL ticker with an unproved or incompatible basis', () => {
  const supported = nativeFundingListings('ETH');
  const hl = supported.find((l) => l.venue === 'HYPERLIQUID')!;
  for (const rateBasis of [null, { id: 'unrelated-fraction', evidence: 'other formula' }]) {
    const result = enumerateFundingCandidates([...supported.filter((l) => l !== hl), { ...hl, rateBasis }]);
    expect(result.candidates).toHaveLength(6);
    expect(result.unpaired[0]?.reason).toBe(rateBasis ? 'rate-basis-mismatch' : 'rate-basis-unverified');
  }
});
