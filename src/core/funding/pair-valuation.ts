/** Cross-basis funding rates can be compared as fractions, not as cash P&L. */
import type { LiveFundingContract } from './ranking';
import { nativeFundingId } from './contract-evidence';
import { parseSymbol } from '../numbers';

export interface FundingRateEstimate {
  short: { price: 'oracle' | 'mark'; settlement: 'USDC' | 'USDT' };
  long: { price: 'oracle' | 'mark'; settlement: 'USDC' | 'USDT' };
}

/** Only the explicitly reviewed native BTC/ETH HL vs USDT CEX products. */
export function fundingRateEstimate(short: LiveFundingContract, long: LiveFundingContract): FundingRateEstimate | null {
  const coin = short.underlying?.id;
  if ((coin !== 'BTC' && coin !== 'ETH') || long.underlying?.id !== coin) return null;
  const basis = (leg: LiveFundingContract): FundingRateEstimate['short'] | null => {
    if (leg.venue === 'HYPERLIQUID' && leg.contractId === coin && leg.rateBasis?.id === 'linear-oracle-notional-fraction') {
      return { price: 'oracle', settlement: 'USDC' };
    }
    if (['BINANCE', 'BYBIT', 'OKX'].includes(leg.venue) && leg.contractId === nativeFundingId(leg.venue, coin, 'USDT')
      && leg.rateBasis?.id === 'linear-mark-notional-fraction') return { price: 'mark', settlement: 'USDT' };
    return null;
  };
  const a = basis(short);
  const b = basis(long);
  return a && b && a.price !== b.price ? { short: a, long: b } : null;
}

/** Fail closed at execution, independently of client labels or rankedness. */
export function fundingValuationUnnormalized(short: { venue: string; symbol: string }, long: { venue: string; symbol: string }): boolean {
  return (short.venue === 'HYPERLIQUID') !== (long.venue === 'HYPERLIQUID')
    || parseSymbol(short.symbol).quote !== parseSymbol(long.symbol).quote;
}
