/** Exact native BTC/ETH products, corroborated by synthetic CrossEx rules. */
import { OKX_ARCHIVE_API } from '../../src/core/funding/history-sources';
import { inferFundingCadence } from '../../src/core/funding/cadence-inference';
import { CUTOFF, D, H, flat, historyLeg } from './funding-ranking-fixture';
import { mapFundingContracts } from '../../src/core/funding/contract-identity';
import type { FundingContractListing } from '../../src/core/funding/market';

export function nativeFundingListings(coin: 'BTC' | 'ETH'): FundingContractListing[] {
  const products = ['BINANCE', 'BYBIT', 'OKX', 'HYPERLIQUID'].map((venue) => ({
    venue, base: coin, quote: venue === 'HYPERLIQUID' ? 'USDC' : 'USDT',
    contractId: venue === 'HYPERLIQUID' ? coin : venue === 'OKX' ? `${coin}-USDT-SWAP` : `${coin}USDT`,
    linear: true, live: true, listing: null, evidence: 'synthetic official native instrument',
  }));
  return mapFundingContracts(products.map((p) => ({ symbol: `${p.venue}_FUTURE_${coin}_${p.quote}`,
    exchangeType: p.venue, businessType: 'FUTURE', state: 'live', delistTime: '0' })), products).listings;
}

/** One year at exact hourly HL and eight-hour CEX settlements; no document rules. */
export function nativeFundingHistories(coin: 'BTC' | 'ETH') {
  return nativeFundingListings(coin).map((listing) => {
    const rates: Record<string, string> = { BINANCE: '0.00008', BYBIT: '0.00016', OKX: '0.0001', HYPERLIQUID: '0.00002' };
    const leg = historyLeg(listing.venue, listing.contractId, flat(rates[listing.venue]!));
    if (listing.venue === 'OKX') leg.source.api = OKX_ARCHIVE_API;
    leg.rules = [];
    leg.listing = null;
    if (listing.venue === 'HYPERLIQUID') {
      leg.source.api = 'info:fundingHistory';
      leg.events = Array.from({ length: 365 * 24 }, (_, i) => ({ settledAt: CUTOFF - 365 * D + (i + 1) * H,
        rate: '0.00002', intervalHours: null, status: 'settled' as const, kind: 'regular' as const, evidence: `synthetic-hour/${i}` }));
      leg.pages.pages = [{ ...leg.pages.pages[0]!, firstAt: leg.events[0]!.settledAt, count: leg.events.length }];
    }
    return inferFundingCadence(leg);
  });
}
