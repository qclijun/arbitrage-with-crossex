/** Read-only venue history, including native contracts that cannot yet form a ranked pair. */
import { isSupportedCoin } from '../../core/coins';
import { parseSymbol } from '../../core/numbers';
import { evaluateFundingLeg, HISTORY_DAYS, snapshotCutoff, type HistoryDays, type LegHistoryResult } from '../../core/funding/history';
import { legKey, windowEvidence, type FundingHistoryCache, type CachedHistoryLeg } from '../../core/funding/history-cache';
import { readyListings, type FundingMarketView } from '../../core/funding/market';

export interface SettlementQuery { underlyings?: string[]; venues?: string[]; offset: number; limit: number; }
export interface SettlementWindow {
  cadence?: LegHistoryResult['cadence'] | null;
  days: HistoryDays; cutoff: number | null; coverage: LegHistoryResult['coverage'] | 'unavailable'; fresh: boolean;
  total: string | null; annualized: string | null; observed: LegHistoryResult['observed']; reasons: string[];
  verifiedAt: number | null;
  lastAttempt?: LegHistoryResult['lastAttempt'];
}
export interface SettlementRow {
  venue: string; contractId: string; symbol: string; assetCode: string;
  windows: SettlementWindow[];
  lastAttempt: LegHistoryResult['lastAttempt'];
  backfill?: CachedHistoryLeg['backfill'];
}
export interface SettlementBoard {
  evaluatedAt: number; snapshotId: string | null; offset: number; limit: number; matched: number;
  options: { underlyings: string[]; venues: string[] }; rows: SettlementRow[];
}

export function buildSettlementBoard(input: { query: SettlementQuery; history: Pick<FundingHistoryCache, 'snapshot'>;
  market: FundingMarketView; now: number }): SettlementBoard {
  const { query, now } = input;
  const snapshot = input.history.snapshot();
  const all = readyListings(input.market.contracts).filter((listing) => listing.symbol)
    .map((listing) => ({ ...listing, assetCode: parseSymbol(listing.symbol!).base }));
  const filtered = all.filter((row) => (!query.underlyings?.length || query.underlyings.includes(row.assetCode))
    && (!query.venues?.length || query.venues.includes(row.venue)))
    .sort((a, b) => Number(isSupportedCoin(b.assetCode)) - Number(isSupportedCoin(a.assetCode))
      || a.assetCode.localeCompare(b.assetCode) || a.venue.localeCompare(b.venue) || a.contractId.localeCompare(b.contractId));
  return {
    evaluatedAt: now, snapshotId: snapshot?.id ?? null, offset: query.offset, limit: query.limit, matched: filtered.length,
    options: { underlyings: [...new Set(all.map((row) => row.assetCode))].sort(), venues: [...new Set(all.map((row) => row.venue))].sort() },
    rows: filtered.slice(query.offset, query.offset + query.limit).map((row) => {
      const cached = snapshot?.legs.get(legKey(row));
      return { venue: row.venue, contractId: row.contractId, symbol: row.symbol!, assetCode: row.assetCode,
        lastAttempt: cached?.leg.lastAttempt ?? null, backfill: cached?.backfill,
        windows: HISTORY_DAYS.map((days) => {
          const read = cached ? windowEvidence(cached, days) : null;
          const result = read && read.cutoff <= snapshotCutoff(now) ? evaluateFundingLeg(read.leg, read.cutoff, days, now) : null;
          const lastAttempt = cached?.leg.lastAttempt ?? null;
          const pending = result?.fresh && result.coverage === 'complete' ? null : lastAttempt?.reason;
          const reasons = [...(result?.reasons ?? ['history-leg-missing']),
            ...(result && read!.cutoff < snapshotCutoff(now) ? ['history-cutoff-behind'] : []), ...(pending ? [pending] : [])];
          return { days, cutoff: result ? read!.cutoff : null, coverage: result?.coverage ?? 'unavailable', fresh: result?.fresh ?? false,
            total: result?.total ?? null, annualized: result?.annualized ?? null, observed: result?.observed ?? null,
            verifiedAt: result?.verifiedAt ?? null, cadence: result?.cadence ?? null, reasons: [...new Set(reasons)], lastAttempt };
        }) };
    }),
  };
}
