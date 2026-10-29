/**
 * The opportunities page's read model (ticket 18): ticket 10's ranking over
 * the published history and the in-memory market, projected to what the page
 * shows. Pure. Execution limits are listed per row and never touch rank or
 * eligibility; costs are not here (tickets 11/13 wire them through a preview).
 */
import { SUPPORTED_COINS } from '../../core/coins';
import { HISTORY_DAYS, type HistoryDays, type LegHistoryResult } from '../../core/funding/history';
import { legKey, type FundingHistoryCache, type HistoryCacheView } from '../../core/funding/history-cache';
import type { FundingContractListing, FundingFeedStatus, FundingMarketView } from '../../core/funding/market';
import {
  enumerateFundingCandidates,
  rankFundingCandidates,
  type CurrentContrast,
  type FundingCandidate,
  type RankingPage,
  type RankingWindow,
  type UnpairedContract,
} from '../../core/funding/ranking';
import { underlyingOf } from '../../core/funding/spreads';
import { parseSymbol } from '../../core/numbers';
import type { AdmissionState } from '../../engine/admission';

export type BoardHistory = Pick<FundingHistoryCache, 'evaluate' | 'snapshot' | 'view'>;

export interface BoardQuery {
  days: HistoryDays;
  compareDays: HistoryDays;
  underlyings?: string[];
  venues?: string[];
  positiveOnly: boolean;
  offset: number;
  limit: number;
  /** The fingerprint of the ranking the caller is paging through. */
  rankingId?: string;
}

export interface BoardLeg {
  venue: string;
  contractId: string;
  /** The CrossEx symbol trading it; null when unproven. */
  symbol: string | null;
}

export interface BoardLegHistory {
  coverage: LegHistoryResult['coverage'];
  fresh: boolean;
  total: string | null;
  annualized: string | null;
  source: LegHistoryResult['source'];
  verifiedAt: number | null;
  lastAttempt: LegHistoryResult['lastAttempt'];
  reasons: string[];
  missingEvents: number;
  missingRanges: LegHistoryResult['missingRanges'];
  conflicts: number;
  specialEvents: number;
}

export interface BoardWindow {
  days: HistoryDays;
  eligible: boolean;
  coverage: RankingWindow['coverage'];
  netTotal: string | null;
  netAnnualized: string | null;
  reasons: string[];
  /** The window's own range; null when the cache has nothing to evaluate. */
  start: number | null;
  cutoff: number | null;
  legs: { short: BoardLegHistory; long: BoardLegHistory } | null;
}

export interface BoardRow {
  id: string;
  underlying: string;
  short: BoardLeg;
  long: BoardLeg;
  rank: number | null;
  windows: BoardWindow[];
  current: CurrentContrast | null;
  executionBlockers: string[];
}

export interface FundingBoard extends Omit<RankingPage, 'rows' | 'fingerprint'> {
  evaluatedAt: number;
  rankingId: string;
  /** The caller's `rankingId` no longer matches: this is page one of the new ranking. */
  rankingChanged: boolean;
  rows: BoardRow[];
  options: { underlyings: string[]; venues: string[] };
  history: HistoryCacheView;
  contracts: { state: FundingMarketView['contracts']['state']; at: number | null; lastAttempt: { at: number; ok: boolean } | null;
    count: number; unpaired: UnpairedContract[] };
  feeds: FundingFeedStatus[];
  /** The new-open switch (ticket 19); null without an engine. Observation never opens anything. */
  admission: AdmissionState | null;
}

const SIDES = ['short', 'long'] as const;

function legHistory(leg: LegHistoryResult): BoardLegHistory {
  return {
    coverage: leg.coverage, fresh: leg.fresh, total: leg.total, annualized: leg.annualized, source: leg.source,
    verifiedAt: leg.verifiedAt, lastAttempt: leg.lastAttempt, reasons: leg.reasons, missingEvents: leg.missingEvents.length,
    missingRanges: leg.missingRanges, conflicts: leg.conflicts.length, specialEvents: leg.specialEvents.length,
  };
}

function window(w: RankingWindow): BoardWindow {
  const { result } = w;
  return {
    days: w.days, eligible: w.eligible, coverage: w.coverage, netTotal: w.netTotal, netAnnualized: w.netAnnualized, reasons: w.reasons,
    start: result?.start ?? null, cutoff: result?.cutoff ?? null,
    legs: result ? { short: legHistory(result.short), long: legHistory(result.long) } : null,
  };
}

/** Why this pair could not be opened as shown, whatever its history: unproven symbol, unit or coin. */
function executionBlockers(candidate: FundingCandidate, listings: Map<string, FundingContractListing>): string[] {
  const out: string[] = [];
  if (!(SUPPORTED_COINS as readonly string[]).includes(candidate.underlying)) out.push('coin-unsupported');
  for (const side of SIDES) {
    const symbol = listings.get(legKey(candidate[side]))?.symbol ?? null;
    if (!symbol) out.push(`${side}:symbol-unmapped`);
    else {
      const { underlying, multiplier } = underlyingOf(parseSymbol(symbol).base);
      if (multiplier !== 1 || underlying !== candidate.underlying) out.push(`${side}:unit-unsupported`);
    }
  }
  return out;
}

export function buildFundingBoard(input: {
  query: BoardQuery;
  history: BoardHistory;
  market: FundingMarketView;
  admission: AdmissionState | null;
  now: number;
}): FundingBoard {
  const { query, history, market, now } = input;
  const listings = market.contracts.state === 'ready' ? market.contracts.listings : [];
  const byLeg = new Map(listings.map((l) => [legKey(l), l]));
  const { candidates, unpaired } = enumerateFundingCandidates(listings);
  const rank = (offset: number) => rankFundingCandidates({
    candidates, history, now, days: query.days, compareDays: query.compareDays,
    filter: { underlyings: query.underlyings, venues: query.venues, positiveOnly: query.positiveOnly },
    page: { offset, limit: query.limit }, current: market.current,
    executionBlockers: (c) => executionBlockers(c, byLeg),
  });
  let page = rank(query.offset);
  const rankingChanged = query.rankingId !== undefined && query.rankingId !== page.fingerprint;
  if (rankingChanged && query.offset !== 0) page = rank(0);
  const { rows, fingerprint, ...summary } = page;
  const leg = (key: FundingCandidate['short']): BoardLeg => ({ ...key, symbol: byLeg.get(legKey(key))?.symbol ?? null });
  const contracts = market.contracts;
  return {
    ...summary,
    evaluatedAt: now,
    rankingId: fingerprint,
    rankingChanged,
    rows: rows.map((row) => ({
      id: row.candidate.id, underlying: row.candidate.underlying, short: leg(row.candidate.short), long: leg(row.candidate.long),
      rank: row.rank, windows: row.windows.map(window), current: row.current, executionBlockers: row.executionBlockers,
    })),
    options: {
      underlyings: [...new Set(candidates.map((c) => c.underlying))].sort(),
      venues: [...new Set(candidates.flatMap((c) => [c.short.venue, c.long.venue]))].sort(),
    },
    history: history.view(now),
    contracts: {
      state: contracts.state,
      at: contracts.state === 'ready' ? contracts.at : null,
      lastAttempt: contracts.state === 'unwired' ? null : contracts.lastAttempt,
      count: listings.length,
      unpaired,
    },
    feeds: market.feeds,
    admission: input.admission,
  };
}

export const isHistoryDays = (n: number): n is HistoryDays => (HISTORY_DAYS as readonly number[]).includes(n);
