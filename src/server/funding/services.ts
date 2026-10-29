/**
 * Production wiring of the funding opportunities (tickets 09/12/18): one
 * published history cache, its background refresher, and the background market
 * poller, shared by the read-only page and the admission routes. Until ticket
 * 22 supplies the official history sources and the proven contract mapping,
 * the market is unwired and reads nothing, and the page says so.
 */
import { FUNDING_FEEDS } from '../../core/funding/feeds';
import { FundingHistoryCache, type HistoryLegKey } from '../../core/funding/history-cache';
import { createFundingHistoryRefresher, type FundingHistorySource } from '../../core/funding/history-collector';
import { createFundingMarket, type FundingContractListing } from '../../core/funding/market';

export function createFundingServices(opts: { contracts?: () => Promise<FundingContractListing[]>; sources?: FundingHistorySource[] } = {}) {
  const history = new FundingHistoryCache();
  const market = createFundingMarket({ contracts: opts.contracts, feeds: FUNDING_FEEDS });
  const listings = (): FundingContractListing[] => {
    const contracts = market.view().contracts;
    return contracts.state === 'ready' ? contracts.listings : [];
  };
  const refresher = createFundingHistoryRefresher({
    cache: history,
    sources: opts.sources ?? [],
    legs: async () => listings().map(({ venue, contractId }) => ({ venue, contractId })),
  });
  const legOf = (symbol: string): HistoryLegKey | null => {
    const hit = listings().find((l) => l.symbol === symbol);
    return hit ? { venue: hit.venue, contractId: hit.contractId } : null;
  };
  return {
    opportunities: { history, market },
    funding: { history, legOf },
    start(): void {
      market.start();
      refresher.start();
    },
    stop(): void {
      market.stop();
      refresher.stop();
    },
  };
}
