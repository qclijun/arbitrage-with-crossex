/**
 * Read-only side of settled funding history. The background refresher is the
 * only writer; readers get the last PUBLISHED snapshot and never trigger a
 * fetch, so a page request cannot reach a venue. Rebuildable in memory: a
 * restart is a cold start (UNKNOWN), never revived old evidence.
 */
import {
  evaluateFundingHistory,
  snapshotCutoff,
  type FundingHistoryLeg,
  type FundingHistoryResult,
  type HistoryDays,
} from './history';

export interface HistoryLegKey {
  venue: string;
  /** Venue-native contract ID. */
  contractId: string;
}

export const legKey = (key: HistoryLegKey): string => `${key.venue}\u0000${key.contractId}`;

export interface CachedHistoryLeg {
  /** The cutoff this leg's evidence was collected for; older than the snapshot's when its refresh failed. */
  cutoff: number;
  /** The most recent verified read. */
  leg: FundingHistoryLeg;
  /**
   * An older read at the same cutoff reaching further back than `leg`: it serves
   * the long windows `leg` does not cover, with its own (older) verification time.
   */
  wider?: FundingHistoryLeg;
}

const DAY = 24 * 60 * 60_000;

/** The read that proves a window: the newest one covering it, else the wider one. */
function windowLeg(cached: CachedHistoryLeg, cutoff: number, days: HistoryDays): FundingHistoryLeg {
  const start = cutoff - days * DAY;
  return cached.wider && cached.leg.pages.rangeStart > start ? cached.wider : cached.leg;
}

export interface HistorySnapshot {
  id: string;
  /** Common cutoff of every comparable result in this snapshot. */
  cutoff: number;
  publishedAt: number;
  legs: ReadonlyMap<string, CachedHistoryLeg>;
}

/** Why a leg's read ended early; also a venue's `stopped` reason. */
export type HistoryStopReason = 'rate-limited' | 'budget-exhausted' | 'deadline' | 'timeout' | 'error'
  | 'page-limit' | 'pagination-stalled' | 'settlement-unnormalized';
/** A leg attempt's failure: a stop, or why no read was made. */
export type HistoryAttemptReason = HistoryStopReason | 'schedule-unverified' | 'no-history-source'
  | 'no-history-read' | 'source-error';

export interface HistoryVenueReport {
  requests: number;
  legs: number;
  /** Legs whose full requested range was read and verified this round. */
  refreshed: number;
  /** Why this venue stopped early (rate-limited, budget-exhausted, deadline), if it did. */
  stopped: HistoryStopReason | null;
}

export interface HistoryRoundReport {
  startedAt: number;
  finishedAt: number;
  cutoff: number;
  outcome: 'published' | 'failed';
  reason?: 'leg-list-failed' | 'round-error';
  requests: number;
  venues: Record<string, HistoryVenueReport>;
}

export interface HistoryPairRequest {
  underlying: string;
  short: HistoryLegKey;
  long: HistoryLegKey;
  days: HistoryDays;
}

export type HistoryCacheView =
  | { state: 'cold'; snapshotId: null; cutoff: null; cutoffBehind: null; publishedAt: null;
    refreshing: boolean; lastRound: HistoryRoundReport | null }
  | { state: 'ready'; snapshotId: string; cutoff: number; cutoffBehind: boolean; publishedAt: number;
    refreshing: boolean; lastRound: HistoryRoundReport | null };

export type HistoryAdmission =
  | { admitted: true; result: FundingHistoryResult }
  | { admitted: false; reason: 'history-cold-start' | 'history-snapshot-superseded'
    | 'history-cutoff-behind' | 'history-leg-missing' | 'history-ineligible'; result?: FundingHistoryResult };

export class FundingHistoryCache {
  private current: HistorySnapshot | null = null;
  private round: HistoryRoundReport | null = null;
  private running = false;

  snapshot(): HistorySnapshot | null {
    return this.current;
  }

  /** Refresher only. */
  setRefreshing(running: boolean): void {
    this.running = running;
  }

  /** Refresher only: swaps the whole snapshot at once, so no reader sees a half-built round. */
  publish(snapshot: HistorySnapshot | null, report: HistoryRoundReport): void {
    if (snapshot) this.current = snapshot;
    this.round = report;
  }

  view(now: number): HistoryCacheView {
    const snap = this.current;
    if (!snap) {
      return { state: 'cold', snapshotId: null, cutoff: null, cutoffBehind: null, publishedAt: null,
        refreshing: this.running, lastRound: this.round };
    }
    return { state: 'ready', snapshotId: snap.id, cutoff: snap.cutoff, cutoffBehind: snap.cutoff < snapshotCutoff(now),
      publishedAt: snap.publishedAt, refreshing: this.running, lastRound: this.round };
  }

  /**
   * Both legs at the snapshot cutoff when they have it. When both legs only hold
   * evidence for the same OLDER cutoff (their refresh failed), the result is bound
   * to that cutoff — stale, observation only. Legs on different cutoffs are never
   * spliced: they are evaluated at the snapshot cutoff, where the older one is UNKNOWN.
   */
  evaluate(pair: HistoryPairRequest, now: number): FundingHistoryResult | null {
    const snap = this.current;
    const short = snap?.legs.get(legKey(pair.short));
    const long = snap?.legs.get(legKey(pair.long));
    // A reader clock behind the snapshot has no window to evaluate.
    if (!snap || !short || !long || snap.cutoff > snapshotCutoff(now)) return null;
    const cutoff = short.cutoff === long.cutoff ? short.cutoff : snap.cutoff;
    return evaluateFundingHistory({ snapshotId: snap.id, underlying: pair.underlying, cutoff, days: pair.days,
      short: windowLeg(short, cutoff, pair.days), long: windowLeg(long, cutoff, pair.days), now });
  }

  /** Server-side history admission: the caller's snapshot must still be current, at the current cutoff, and eligible now. */
  recheck(request: HistoryPairRequest & { snapshotId: string }, now: number): HistoryAdmission {
    const snap = this.current;
    if (!snap) return { admitted: false, reason: 'history-cold-start' };
    if (snap.id !== request.snapshotId) return { admitted: false, reason: 'history-snapshot-superseded' };
    if (snap.cutoff !== snapshotCutoff(now)) return { admitted: false, reason: 'history-cutoff-behind' };
    const result = this.evaluate(request, now);
    if (!result) return { admitted: false, reason: 'history-leg-missing' };
    if (!result.historyEligible || result.cutoff !== snap.cutoff) return { admitted: false, reason: 'history-ineligible', result };
    return { admitted: true, result };
  }
}
