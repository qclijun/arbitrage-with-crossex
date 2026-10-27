/**
 * Directed perp-vs-perp funding candidates and their historical ranking. A
 * candidate is one exact short contract against one exact long contract on
 * another venue; every comparable direction is kept, never only a coin's
 * current best pair. Ranking reads the published history cache only, and the
 * score is the pure settled funding-rate spread: no costs, leverage or
 * execution permission are implied. Pure: callers supply the live contracts.
 */
import { HISTORY_DAYS, divideRounded, parseDecimal, scale, snapshotCutoff, type Coverage, type FundingHistoryResult, type HistoryDays } from './history';
import { legKey, type FundingHistoryCache, type HistoryLegKey } from './history-cache';

export interface LiveFundingContract {
  venue: string;
  /** Venue-native contract ID. */
  contractId: string;
  /** Proven economic underlying; a ticker or alias match alone is not proof. */
  underlying: { id: string; evidence: string } | null;
  /** Proven funding-rate basis; legs pair only on the same one. */
  rateBasis: { id: string; evidence: string } | null;
}

export interface FundingCandidate {
  /** Stable identity: underlying, short leg, long leg. */
  id: string;
  underlying: string;
  /** Receives funding when the spread is positive. */
  short: HistoryLegKey;
  long: HistoryLegKey;
}

export interface UnpairedContract {
  venue: string;
  contractId: string;
  /** `rate-basis-mismatch`: the same underlying trades on another venue, but on a different funding-rate basis. */
  reason: 'identity-conflict' | 'underlying-unverified' | 'rate-basis-unverified' | 'rate-basis-mismatch' | 'no-comparable-peer';
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byLeg = (a: HistoryLegKey, b: HistoryLegKey): number => byText(a.venue, b.venue) || byText(a.contractId, b.contractId);

/** Ascending stable identity: the order of true ties. */
export const compareCandidates = (a: FundingCandidate, b: FundingCandidate): number =>
  byText(a.underlying, b.underlying) || byLeg(a.short, b.short) || byLeg(a.long, b.long);

export function enumerateFundingCandidates(contracts: LiveFundingContract[]): {
  candidates: FundingCandidate[];
  unpaired: UnpairedContract[];
} {
  const unique = new Map<string, LiveFundingContract | null>();
  for (const contract of contracts) {
    const key = JSON.stringify([contract.venue, contract.contractId]);
    const seen = unique.get(key);
    if (seen === undefined) unique.set(key, contract);
    // The same contract claimed as two assets or bases is proof of neither.
    else if (seen && (seen.underlying?.id !== contract.underlying?.id || seen.rateBasis?.id !== contract.rateBasis?.id)) unique.set(key, null);
  }
  const unpaired: UnpairedContract[] = [];
  const groups = new Map<string, LiveFundingContract[]>();
  for (const [key, contract] of unique) {
    if (!contract) {
      const [venue, contractId] = JSON.parse(key) as [string, string];
      unpaired.push({ venue, contractId, reason: 'identity-conflict' });
    } else if (!contract.underlying?.id || !contract.underlying.evidence) {
      unpaired.push({ venue: contract.venue, contractId: contract.contractId, reason: 'underlying-unverified' });
    } else if (!contract.rateBasis?.id || !contract.rateBasis.evidence) {
      unpaired.push({ venue: contract.venue, contractId: contract.contractId, reason: 'rate-basis-unverified' });
    } else {
      const group = JSON.stringify([contract.underlying.id, contract.rateBasis.id]);
      groups.set(group, [...(groups.get(group) ?? []), contract]);
    }
  }
  const candidates: FundingCandidate[] = [];
  for (const group of groups.values()) {
    for (const short of group) {
      const peers = group.filter((long) => long.venue !== short.venue);
      if (!peers.length) {
        // Only a proven basis on another venue can prove a mismatch.
        const elsewhere = [...groups.values()].some((other) => other[0].rateBasis!.id !== short.rateBasis!.id
          && other.some((peer) => peer.venue !== short.venue && peer.underlying!.id === short.underlying!.id));
        unpaired.push({ venue: short.venue, contractId: short.contractId, reason: elsewhere ? 'rate-basis-mismatch' : 'no-comparable-peer' });
      }
      for (const long of peers) {
        const underlying = short.underlying!.id;
        candidates.push({
          id: JSON.stringify([underlying, short.venue, short.contractId, long.venue, long.contractId]),
          underlying,
          short: { venue: short.venue, contractId: short.contractId },
          long: { venue: long.venue, contractId: long.contractId },
        });
      }
    }
  }
  return { candidates: candidates.sort(compareCandidates), unpaired: unpaired.sort(byLeg) };
}

export interface RankingWindow {
  days: HistoryDays;
  /** This window's history is complete and fresh, so it may be ranked. */
  eligible: boolean;
  coverage: Coverage | 'unavailable';
  /** Exact signed short-minus-long settled total; null unless complete. */
  netTotal: string | null;
  netAnnualized: string | null;
  /** Why the window is not ranked: availability, coverage with per-leg reasons, then staleness. */
  reasons: string[];
  /** null when the cache holds nothing to evaluate for this pair. */
  result: FundingHistoryResult | null;
}

/** A leg's current-period rate as its venue quotes it; a fraction per funding interval. */
export interface CurrentFundingRate {
  rate: string;
  intervalHours: number;
  at: number;
}

export interface CurrentContrast {
  short: CurrentFundingRate;
  long: CurrentFundingRate;
  /** Current short-minus-long rate annualized at each leg's own interval. */
  netAnnualized: string;
  /**
   * Current spread has the opposite sign to the selected window's; a hint only, never a re-rank or swap.
   * null unless the selected window is ranked.
   */
  reversed: boolean | null;
}

export interface RankingRow {
  candidate: FundingCandidate;
  /** 1-based place among the ranked rows of the filtered list; null for observation rows. */
  rank: number | null;
  /** All five windows on the same two legs, shortest first. */
  windows: RankingWindow[];
  /** null without a valid current quote for both legs. */
  current: CurrentContrast | null;
  /** Caller's execution blockers, kept apart from history: they never change rank or eligibility. */
  executionBlockers: string[];
}

export interface RankingPage {
  snapshotId: string | null;
  days: HistoryDays;
  compareDays: HistoryDays;
  /** Every candidate, before filters. */
  candidateCount: number;
  /** Candidates left after filters. */
  matched: number;
  /** Matched candidates ranked in the selected window. */
  rankedCount: number;
  offset: number;
  limit: number;
  rows: RankingRow[];
}

type HistoryReader = Pick<FundingHistoryCache, 'evaluate' | 'snapshot'>;

const SIDES = ['short', 'long'] as const;
const signum = (value: bigint): number => (value > 0n ? 1 : value < 0n ? -1 : 0);

function readWindow(history: HistoryReader, candidate: FundingCandidate, days: HistoryDays, now: number): RankingWindow {
  const result = history.evaluate({ underlying: candidate.underlying, short: candidate.short, long: candidate.long, days }, now);
  const reasons: string[] = [];
  const snap = history.snapshot();
  if (!result) {
    if (!snap) reasons.push('history-cold-start');
    else if (snap.cutoff > snapshotCutoff(now)) reasons.push('history-clock-behind');
    else for (const side of SIDES) if (!snap.legs.has(legKey(candidate[side]))) reasons.push(`${side}:history-leg-missing`);
  } else {
    if (result.cutoff < snapshotCutoff(now)) reasons.push('history-cutoff-behind');
    if (result.coverage !== 'complete') {
      reasons.push(`history-${result.coverage}`);
      for (const side of SIDES) for (const reason of new Set(result[side].reasons)) reasons.push(`${side}:${reason}`);
    }
    for (const side of SIDES) if (!result[side].fresh) reasons.push(`${side}:history-stale`);
  }
  return {
    days,
    eligible: result?.historyEligible ?? false,
    coverage: result?.coverage ?? 'unavailable',
    netTotal: result?.netTotal ?? null,
    netAnnualized: result?.netAnnualized ?? null,
    reasons,
    result,
  };
}

/** Exact signed totals of one window share its length, so they order exactly as their annualized rates. */
function compareTotals(a: string, b: string): number {
  const x = parseDecimal(a)!;
  const y = parseDecimal(b)!;
  const places = Math.max(x.places, y.places);
  return signum(scale(x, places) - scale(y, places));
}

const HOURS_IN_YEAR = 8760n;
const HOUR_MS = 3_600_000;

/** A quote belongs to the current period only within one funding interval of `now`. */
const inPeriod = (quote: CurrentFundingRate | undefined, now: number): quote is CurrentFundingRate =>
  !!quote && parseDecimal(quote.rate) !== null && Number.isSafeInteger(quote.intervalHours) && quote.intervalHours > 0
  && Number.isSafeInteger(quote.at) && quote.at <= now && now - quote.at < quote.intervalHours * HOUR_MS;

function contrast(
  candidate: FundingCandidate,
  current: ReadonlyMap<string, CurrentFundingRate> | undefined,
  selected: RankingWindow,
  now: number,
): CurrentContrast | null {
  const short = current?.get(legKey(candidate.short));
  const long = current?.get(legKey(candidate.long));
  if (!inPeriod(short, now) || !inPeriod(long, now)) return null;
  const shortRate = parseDecimal(short.rate)!;
  const longRate = parseDecimal(long.rate)!;
  const places = Math.max(shortRate.places, longRate.places, 18);
  const shortHours = BigInt(short.intervalHours);
  const longHours = BigInt(long.intervalHours);
  const numerator = (scale(shortRate, places) * longHours - scale(longRate, places) * shortHours) * HOURS_IN_YEAR;
  return {
    short,
    long,
    netAnnualized: divideRounded(numerator, shortHours * longHours, places),
    reversed: selected.eligible ? compareTotals(selected.netTotal!, '0') * signum(numerator) < 0 : null,
  };
}

export function rankFundingCandidates(input: {
  candidates: FundingCandidate[];
  history: HistoryReader;
  now: number;
  days?: HistoryDays;
  compareDays?: HistoryDays;
  /** View filters only: the candidate set and its count are unchanged. */
  filter?: { underlyings?: string[]; venues?: string[]; positiveOnly?: boolean };
  page?: { offset: number; limit: number };
  /** Current-period rates by `legKey`, for contrast only. */
  current?: ReadonlyMap<string, CurrentFundingRate>;
  executionBlockers?: (candidate: FundingCandidate) => string[];
}): RankingPage {
  const days = input.days ?? 30;
  const compareDays = input.compareDays ?? 7;
  if (!HISTORY_DAYS.includes(days) || !HISTORY_DAYS.includes(compareDays)) throw new Error('Invalid ranking window');
  const { offset, limit } = input.page ?? { offset: 0, limit: 50 };
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid ranking page');
  const { underlyings, venues, positiveOnly } = input.filter ?? {};
  const scored = input.candidates
    .filter((c) => (!underlyings || underlyings.includes(c.underlying))
      && (!venues || venues.includes(c.short.venue) || venues.includes(c.long.venue)))
    .map((candidate) => ({ candidate, selected: readWindow(input.history, candidate, days, input.now) }))
    // Only a ranked spread can be proven positive; UNKNOWN and stale rows are not.
    .filter(({ selected }) => !positiveOnly || (selected.eligible && compareTotals(selected.netTotal!, '0') > 0));
  // Ranked rows by exact score, then observation rows; UNKNOWN is never scored as zero.
  scored.sort((a, b) => Number(b.selected.eligible) - Number(a.selected.eligible)
    || (a.selected.eligible ? compareTotals(b.selected.netTotal!, a.selected.netTotal!) : 0)
    || compareCandidates(a.candidate, b.candidate));
  const rankedCount = scored.filter((row) => row.selected.eligible).length;
  const rows = scored.slice(offset, offset + limit).map(({ candidate, selected }, index) => ({
    candidate,
    rank: selected.eligible ? offset + index + 1 : null,
    windows: HISTORY_DAYS.map((d) => (d === days ? selected : readWindow(input.history, candidate, d, input.now))),
    current: contrast(candidate, input.current, selected, input.now),
    executionBlockers: [...(input.executionBlockers?.(candidate) ?? [])],
  }));
  return {
    snapshotId: input.history.snapshot()?.id ?? null,
    days,
    compareDays,
    candidateCount: input.candidates.length,
    matched: scored.length,
    rankedCount,
    offset,
    limit,
    rows,
  };
}
