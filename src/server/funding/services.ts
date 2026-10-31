/**
 * Production wiring of the funding opportunities (tickets 09/12/18): one
 * published history cache, its background refresher, and the background market
 * poller, shared by the read-only page and the admission routes. Production
 * supplies official sources and the corroborated contract catalog (ticket 22).
 */
import { FUNDING_FEEDS } from '../../core/funding/feeds';
import { FundingHistoryCache, legKey, type HistoryLegKey } from '../../core/funding/history-cache';
import { createFundingHistoryRefresher, type FundingHistorySource } from '../../core/funding/history-collector';
import { createFundingMarket, readyListings, type FundingMarketDeps } from '../../core/funding/market';
import { isSupportedCoin } from '../../core/coins';
import { parseSymbol } from '../../core/numbers';

export function createFundingServices(opts: { contracts?: FundingMarketDeps['contracts']; sources?: FundingHistorySource[] } = {}) {
  const history = new FundingHistoryCache();
  const market = createFundingMarket({ contracts: opts.contracts, feeds: FUNDING_FEEDS });
  const listings = () => readyListings(market.view().contracts);
  let preferred = new Set<string>();
  const refresher = createFundingHistoryRefresher({
    inferCadence: true,
    cache: history,
    sources: opts.sources ?? [],
    // CEX archives remain serial; HL refreshes peers' recent windows before backfill.
    budget: { venueConcurrency: 1 },
    legs: async () => {
      const rows = listings();
      // Scheduling preference only: a native asset code does not prove economic identity.
      preferred = new Set(rows.filter((row) => row.symbol && isSupportedCoin(parseSymbol(row.symbol).base)).map(legKey));
      return rows.map(({ venue, contractId }) => ({ venue, contractId }));
    },
    priority: (key) => key.venue === 'HYPERLIQUID' && ['BTC', 'ETH'].includes(key.contractId)
      ? 2 : preferred.has(legKey(key)) ? 1 : 0,
  });
  const legOf = (symbol: string): HistoryLegKey | null => {
    const hits = listings().filter((l) => l.symbol === symbol);
    return hits.length === 1 ? { venue: hits[0]!.venue, contractId: hits[0]!.contractId } : null;
  };
  let started = false;
  return {
    async runOnce() {
      await market.runOnce();
      return refresher.runOnce();
    },
    opportunities: { history, market },
    funding: { history, legOf },
    start(): void {
      if (started) return;
      started = true;
      market.start();
      // The first history round needs the catalog, rather than publishing an
      // empty cold-start round while native instrument reads are in flight.
      void market.runOnce().then(() => { if (started) refresher.start(); });
    },
    stop(): void {
      started = false;
      market.stop();
      refresher.stop();
    },
  };
}
