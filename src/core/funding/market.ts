/**
 * The live side of the funding opportunities page (ticket 18): the proven
 * contract list and the current-period quotes of the venues it trades, read in
 * the background into memory. The page reads `view()` only, so a browser
 * request never reaches a venue. A failed read keeps the last evidence with its
 * original time; quotes outlive no more than their own funding interval
 * (ranking.ts drops them past it).
 */
import { classifyGateError } from '../errors';
import type { VenueFundingRate } from './feeds';
import { legKey } from './history-cache';
import type { CurrentFundingRate, LiveFundingContract } from './ranking';

export interface FundingContractListing extends LiveFundingContract {
  /** The CrossEx symbol trading this contract; null when that mapping is unproven. */
  symbol: string | null;
}

export type FundingContractsView =
  | { state: 'unwired' }
  | { state: 'cold'; lastAttempt: { at: number; ok: false } | null }
  | { state: 'ready'; at: number; listings: FundingContractListing[]; lastAttempt: { at: number; ok: boolean } };

export interface MarketFeedStatus {
  venue: string;
  ok: boolean;
  /** Last successful read; its quotes are still served after a failure. */
  at: number | null;
  count: number;
  /** An error category, or `no-feed` when no public funding source is wired for the venue. */
  error: string | null;
}

export interface FundingMarketView {
  contracts: FundingContractsView;
  /** Current-period quotes by `legKey`. */
  current: ReadonlyMap<string, CurrentFundingRate>;
  feeds: MarketFeedStatus[];
}

export interface FundingMarketDeps {
  /** Ticket 22's proven contract mapping. Absent, the market is unwired and reads nothing. */
  contracts?: () => Promise<FundingContractListing[]>;
  feeds: Record<string, () => Promise<VenueFundingRate[]>>;
  intervalMs?: number;
  now?: () => number;
}

/** The proven contracts, or none until they have been read. */
export const readyListings = (contracts: FundingContractsView): FundingContractListing[] =>
  contracts.state === 'ready' ? contracts.listings : [];

interface VenueQuotes {
  at: number;
  quotes: Map<string, CurrentFundingRate>;
}

export function createFundingMarket(deps: FundingMarketDeps) {
  const now = deps.now ?? Date.now;
  let contracts: FundingContractsView = deps.contracts ? { state: 'cold', lastAttempt: null } : { state: 'unwired' };
  const quotes = new Map<string, VenueQuotes>();
  let feeds: MarketFeedStatus[] = [];
  let inflight: Promise<void> | null = null;

  async function readContracts(read: () => Promise<FundingContractListing[]>): Promise<void> {
    try {
      const listings = await read();
      const at = now();
      contracts = { state: 'ready', at, listings, lastAttempt: { at, ok: true } };
    } catch {
      const lastAttempt = { at: now(), ok: false as const };
      contracts = contracts.state === 'ready' ? { ...contracts, lastAttempt } : { state: 'cold', lastAttempt };
    }
  }

  async function readVenue(venue: string): Promise<MarketFeedStatus> {
    const prior = quotes.get(venue);
    const kept = { at: prior?.at ?? null, count: prior?.quotes.size ?? 0 };
    const feed = deps.feeds[venue];
    if (!feed) return { venue, ok: false, ...kept, error: 'no-feed' };
    let rows: VenueFundingRate[];
    try {
      rows = await feed();
    } catch (err) {
      return { venue, ok: false, ...kept, error: classifyGateError(err).category };
    }
    // A feed that parses to nothing is a broken feed, not a venue with no contracts.
    if (!rows.length) return { venue, ok: false, ...kept, error: 'empty' };
    const at = now();
    quotes.set(venue, { at, quotes: new Map(rows.map((r) => [legKey({ venue, contractId: r.contractId }),
      { rate: r.rateText, intervalHours: r.intervalHours, at }])) });
    return { venue, ok: true, at, count: rows.length, error: null };
  }

  async function round(): Promise<void> {
    if (!deps.contracts) return;
    await readContracts(deps.contracts);
    if (contracts.state !== 'ready') return;
    const venues = [...new Set(contracts.listings.map((l) => l.venue))].sort();
    for (const venue of quotes.keys()) if (!venues.includes(venue)) quotes.delete(venue);
    feeds = await Promise.all(venues.map(readVenue));
  }

  function runOnce(): Promise<void> {
    inflight ??= round().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    runOnce,
    view(): FundingMarketView {
      const current = new Map<string, CurrentFundingRate>();
      for (const venue of quotes.values()) for (const [key, quote] of venue.quotes) current.set(key, quote);
      return { contracts, current, feeds };
    },
    /** Reads now and every interval; does nothing while unwired. */
    start(): void {
      if (timer || !deps.contracts) return;
      void runOnce();
      timer = setInterval(() => void runOnce(), deps.intervalMs ?? 60_000);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type FundingMarket = ReturnType<typeof createFundingMarket>;
