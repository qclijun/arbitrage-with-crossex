/**
 * Production wiring of the funding opportunities (tickets 09/12/18): one
 * published history cache, its background refresher, and the background market
 * poller, shared by the read-only page and the admission routes. Production
 * supplies official sources and the corroborated contract catalog (ticket 22).
 */
import { FUNDING_FEEDS } from '../../core/funding/feeds';
import { FundingHistoryCache, type HistoryLegKey } from '../../core/funding/history-cache';
import { createFundingHistoryRefresher, type FundingHistorySource } from '../../core/funding/history-collector';
import { createFundingMarket, readyListings, type FundingMarketDeps } from '../../core/funding/market';

export function createFundingServices(opts: { contracts?: FundingMarketDeps['contracts']; sources?: FundingHistorySource[] } = {}) {
  const history = new FundingHistoryCache();
  const market = createFundingMarket({ contracts: opts.contracts, feeds: FUNDING_FEEDS });
  const listings = () => readyListings(market.view().contracts);
  const refresher = createFundingHistoryRefresher({
    cache: history,
    sources: opts.sources ?? [],
    legs: async () => listings().map(({ venue, contractId }) => ({ venue, contractId })),
    // Quotes are keyed by `legKey` of the venue-native contract ID, the same key the refresher reads.
    currentSchedules: () => market.view().current,
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
