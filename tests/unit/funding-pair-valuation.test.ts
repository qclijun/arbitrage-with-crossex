import { expect, it } from 'vitest';
import { stableParityRates } from '../../src/core/funding/pair-valuation';

it('values stablecoin quotes at par, needs nothing for one quote, and knows no rate for anything else', () => {
  expect(stableParityRates(['USDT', 'USDT'], 'USDT', 7)).toEqual([]);
  expect(stableParityRates(['USDC', 'USDT'], 'USDT', 7)).toEqual([
    { from: 'USDC', to: 'USDT', rate: '1', source: 'parity: 1 USDC = 1 USDT = 1 USD', at: 7, basis: 'assumed' },
    { from: 'USDT', to: 'USDC', rate: '1', source: 'parity: 1 USDC = 1 USDT = 1 USD', at: 7, basis: 'assumed' },
  ]);
  expect(stableParityRates(['USD', 'USDT'], 'USDT', 7)?.map((r) => r.from)).toEqual(['USD', 'USDT']);
  expect(stableParityRates(['BTC', 'USDT'], 'USDT', 7)).toBeNull();
  expect(stableParityRates(['USDC'], 'EUR', 7)).toBeNull();
});
