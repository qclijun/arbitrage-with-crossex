/**
 * Production wiring of the funding opportunities (tickets 09/12/18): one
 * published history cache, its background refresher, and the background market
 * poller, shared by the read-only page and the admission routes. Production
 * supplies official sources and the corroborated contract catalog (ticket 22),
 * and the local history cache file that a restart restores from.
 */
import { FUNDING_FEEDS } from '../../core/funding/feeds';
import { FundingHistoryCache, legKey, type HistoryLegKey } from '../../core/funding/history-cache';
import { createFundingHistoryRefresher, type FundingHistorySource } from '../../core/funding/history-collector';
import { captureHistory, restoredSnapshot, type HistoryPersistence, type PersistedHistory } from '../../core/funding/history-persistence';
import { createFundingMarket, readyListings, type FundingMarketDeps } from '../../core/funding/market';
import { isSupportedCoin } from '../../core/coins';
import { parseSymbol } from '../../core/numbers';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createFundingServices(opts: { contracts?: FundingMarketDeps['contracts']; sources?: FundingHistorySource[];
  persistence?: HistoryPersistence } = {}) {
  const history = new FundingHistoryCache();
  const { persistence } = opts;
  // Latest round wins: a save still running when the next round publishes is followed by one more, never a queue.
  let pending: PersistedHistory | null = null;
  let saving = false;
  async function drain(): Promise<void> {
    if (saving || !persistence) return;
    saving = true;
    try {
      for (let state = pending; state; state = pending) {
        pending = null;
        try {
          await persistence.save(state);
          history.setPersistence({ lastSave: { at: Date.now(), outcome: 'saved' } });
        } catch (err) {
          // The published snapshot and page reads are unaffected; only the reason is kept.
          history.setPersistence({ lastSave: { at: Date.now(), outcome: 'failed', reason: message(err) } });
        }
      }
    } finally {
      saving = false;
    }
  }
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
    ...(persistence ? { persist: (snapshot, progress, backfilled) => {
      pending = captureHistory(snapshot, progress, backfilled);
      void drain();
    } } : {}),
  });
  let restoring: Promise<void> | null = null;
  /** Show the saved snapshot (observation only) and resume its backfill jobs before the first round. */
  function restore(): Promise<void> {
    if (!persistence) return Promise.resolve();
    restoring ??= persistence.load().then((result) => {
      const at = Date.now();
      if (result.outcome === 'restored') {
        history.restore(restoredSnapshot(result.state));
        refresher.restore(result.state);
        history.setPersistence({ restore: { at, outcome: 'restored', legs: result.state.snapshot.legs.size } });
      } else {
        history.setPersistence({ restore: { at, outcome: result.outcome, ...(result.outcome === 'empty' ? {} : { reason: result.reason }) } });
      }
    }, (err) => history.setPersistence({ restore: { at: Date.now(), outcome: 'unavailable', reason: message(err) } }));
    return restoring;
  }
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
    restore,
    opportunities: { history, market },
    funding: { history, legOf },
    start(): void {
      if (started) return;
      started = true;
      market.start();
      // The first history round needs the catalog, rather than publishing an
      // empty cold-start round while native instrument reads are in flight,
      // and the restored jobs, so it resumes them instead of starting over.
      void Promise.all([restore(), market.runOnce()]).then(() => { if (started) refresher.start(); });
    },
    stop(): void {
      started = false;
      market.stop();
      refresher.stop();
    },
  };
}
