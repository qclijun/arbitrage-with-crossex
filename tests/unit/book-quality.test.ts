/** The shared book-availability predicate and the bare same-side best quote. */
import { describe, expect, it } from 'vitest';
import { bestQuotePrice, isQuotableBook, topOf } from '../../src/engine/bookQuality';

describe('isQuotableBook', () => {
  it('accepts a normal two-sided book with a positive spread', () => {
    expect(isQuotableBook({ bid: 100.01, ask: 100.02 })).toBe(true);
  });

  it('rejects a crossable (equal) book — ask is not greater than bid', () => {
    expect(isQuotableBook({ bid: 100, ask: 100 })).toBe(false);
  });

  it('rejects a crossed book', () => {
    expect(isQuotableBook({ bid: 100.02, ask: 100.01 })).toBe(false);
  });

  it('rejects a one-sided book (a legal object today, but not quotable)', () => {
    expect(isQuotableBook({ bid: 100, ask: null })).toBe(false);
    expect(isQuotableBook({ bid: null, ask: 101 })).toBe(false);
  });

  it('rejects absurd/non-finite/non-positive levels rather than coercing', () => {
    expect(isQuotableBook({ bid: NaN, ask: 101 })).toBe(false);
    expect(isQuotableBook({ bid: 0, ask: 101 })).toBe(false);
    expect(isQuotableBook({ bid: -1, ask: 101 })).toBe(false);
    expect(isQuotableBook({ bid: Infinity, ask: 101 })).toBe(false);
    expect(isQuotableBook(null)).toBe(false);
    expect(isQuotableBook(undefined)).toBe(false);
  });
});

describe('topOf', () => {
  it('lifts positive finite values and nulls everything else', () => {
    expect(topOf('100.5', 100.6)).toEqual({ bid: 100.5, ask: 100.6 });
    expect(topOf(undefined, null)).toEqual({ bid: null, ask: null });
    expect(topOf('0', '0')).toEqual({ bid: null, ask: null });
    expect(topOf('abc', 100)).toEqual({ bid: null, ask: 100 });
  });
});

describe('bestQuotePrice', () => {
  it('quotes the BARE same-side best — no spread offset (unlike the old touch)', () => {
    // 2·bid − ask would be 99.99 / 2·ask − bid would be 100.04; 'best' must NOT
    // apply that offset.
    const book = { bid: 100.0, ask: 100.03 };
    expect(bestQuotePrice(book, 'BUY', 'BINANCE_FUTURE_ETH_USDT', '0.01')).toBe('100');
    expect(bestQuotePrice(book, 'SELL', 'BINANCE_FUTURE_ETH_USDT', '0.01')).toBe('100.03');
  });

  it('snaps directionally: BUY floors, SELL ceils, away from crossing', () => {
    const book = { bid: 100.017, ask: 100.018 };
    expect(bestQuotePrice(book, 'BUY', 'BINANCE_FUTURE_ETH_USDT', '0.01')).toBe('100.01');
    expect(bestQuotePrice(book, 'SELL', 'BINANCE_FUTURE_ETH_USDT', '0.01')).toBe('100.02');
  });

  it('returns null for a degenerate book — the caller places nothing', () => {
    expect(bestQuotePrice({ bid: 100, ask: null }, 'BUY', 'BINANCE_FUTURE_ETH_USDT', '0.01')).toBeNull();
    expect(bestQuotePrice({ bid: 100.02, ask: 100.01 }, 'BUY', 'BINANCE_FUTURE_ETH_USDT', '0.01')).toBeNull();
  });

  it('applies the Hyperliquid 5-sig-fig cap in the SAFE direction (BUY never rounds up)', () => {
    // At ~61717.85 the 5-sig-fig cap gives up several ticks; a BUY must round
    // DOWN to 61717, never up to 61718 (which could cross the ask).
    const book = { bid: 61717.85, ask: 61717.9 };
    const buy = bestQuotePrice(book, 'BUY', 'HYPERLIQUID_FUTURE_ETH_USDC', '0.01');
    expect(Number(buy)).toBeLessThanOrEqual(61717.85);
    expect(buy).toBe('61717');
    const sell = bestQuotePrice(book, 'SELL', 'HYPERLIQUID_FUTURE_ETH_USDC', '0.01');
    expect(Number(sell)).toBeGreaterThanOrEqual(61717.9);
  });
});
