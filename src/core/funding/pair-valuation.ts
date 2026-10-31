/** Cross-basis funding pairs: rates compare as fractions; cash is valued with stablecoins at par. */
import type { LiveFundingContract } from './ranking';
import { nativeFundingId } from './contract-evidence';
import type { FxRate } from './scenario';

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

/** Stablecoin quotes valued at par, as the Opportunities page does: 1 USDC = 1 USDT = 1 USD. */
const PAR_STABLES = new Set(['USDT', 'USDC', 'USD']);

/** Parity rates from each leg quote into `currency`; [] when no conversion is
 * needed, null when a quote is not a par stablecoin (its rate is unknown). */
export function stableParityRates(quotes: string[], currency: string, at: number): FxRate[] | null {
  const foreign = [...new Set(quotes.map((q) => q.toUpperCase()))].filter((q) => q !== currency);
  if (!foreign.length) return [];
  if (!PAR_STABLES.has(currency) || !foreign.every((q) => PAR_STABLES.has(q))) return null;
  const source = 'parity: 1 USDC = 1 USDT = 1 USD';
  return foreign.flatMap((q) => [
    { from: q, to: currency, rate: '1', source, at, basis: 'assumed' as const },
    { from: currency, to: q, rate: '1', source, at, basis: 'assumed' as const },
  ]);
}
