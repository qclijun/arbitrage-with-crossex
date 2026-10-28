import { describe, expect, it } from 'vitest';
import { signedPositions } from '../../src/server/livePositions';

describe('signedPositions', () => {
  it('takes the venue side over the size sign, and sums rows per contract', () => {
    expect(Object.fromEntries(signedPositions([
      { symbol: 'okx_future_eth_usdt', positionQty: '0.5', positionSide: 'SHORT' },
      { symbol: 'OKX_FUTURE_ETH_USDT', positionQty: '-0.25' },
      { symbol: 'BINANCE_FUTURE_ETH_USDT', positionQty: '1.2', positionSide: 'LONG' },
    ]))).toEqual({ OKX_FUTURE_ETH_USDT: '-0.75', BINANCE_FUTURE_ETH_USDT: '1.2' });
  });

  it('refuses an unreadable body or size rather than reading it as flat', () => {
    expect(() => signedPositions({ message: 'maintenance' })).toThrow(/unreadable/);
    expect(() => signedPositions([{ symbol: 'X', positionQty: '1e-3' }])).toThrow();
  });
});
