/**
 * Read-only side of settled funding history. The background refresher is the
 * only writer; readers get the last PUBLISHED snapshot and never trigger a
 * fetch, so a page request cannot reach a venue. Rebuildable: a restart either
 * restores the last saved snapshot as observation-only `restored` reads (original
 * timestamps, never fresh) or is a cold start (UNKNOWN).
 */
import {
  carryCovers,
  evaluateFundingHistory,
  snapshotCutoff,
  type FundingHistoryLeg,
  type HistoryCarry,
  type FundingHistoryResult,
  type HistoryDays,
} from './history';

export interface HistoryLegKey {
  venue: string;
  /** Venue-native contract ID. */
  contractId: string;
}

export const legKey = (key: HistoryLegKey): string => `${key.venue}\u0000${key.contractId}`;

export interface HistoryWindowEvidence { cutoff: number; leg: FundingHistoryLeg; }

export interface CachedHistoryLeg {
  /** Bounded independent window evidence, kept at its own cutoff and verification time. */
  retained?: HistoryWindowEvidence[];
  backfill?: { cutoff: number; completeThroughDays: number; pendingDays: number | null; pagesRead: number };
  /** The cutoff this leg's evidence was collected for; older than the snapshot's when its refresh failed. */
  cutoff: number;
  /** The most recent verified read. */
  leg: FundingHistoryLeg;
  /**
   * An older read at the same cutoff reaching further back than `leg`: it serves
   * the long windows `leg` does not cover, with its own (older) verification time.
   */
  wider?: FundingHistoryLeg;
  /**
   * The refresher's finding at round cutoff `cutoff` that this leg was not due:
   * its next settlement after the read's cutoff `from` is `next`, past `cutoff`.
   * It extends `leg` and `wider` (both at `from`) to `cutoff` without a re-read.
   */
  carried?: HistoryCarry & { cutoff: number; at: number; evidence: string };
}

const DAY = 24 * 60 * 60_000;

/** The read that proves a window: the newest one covering it, else the wider one. */
export function windowLeg(cached: CachedHistoryLeg, cutoff: number, days: HistoryDays): FundingHistoryLeg {
  const start = cutoff - days * DAY;
  return cached.wider && cached.leg.pages.rangeStart > start ? cached.wider : cached.leg;
}

export function historyReads(cached: CachedHistoryLeg): HistoryWindowEvidence[] {
  return [{ cutoff: cached.cutoff, leg: cached.leg },
    ...(cached.wider ? [{ cutoff: cached.cutoff, leg: cached.wider }] : []), ...(cached.retained ?? [])];
}

/**
 * Shared evidence ordering and range proof for both retention and window reads.
 * At one cutoff a read made by this process beats a restored one, whatever their
 * times: a resumed backfill job finishing after the recent read must not shadow it.
 */
export const compareHistoryEvidence = (a: HistoryWindowEvidence, b: HistoryWindowEvidence): number =>
  b.cutoff - a.cutoff || Number(a.leg.restored === true) - Number(b.leg.restored === true)
    || (b.leg.verifiedAt ?? -Infinity) - (a.leg.verifiedAt ?? -Infinity);

export function coversHistoryWindow({ cutoff, leg }: HistoryWindowEvidence, days: HistoryDays): boolean {
  return leg.verifiedAt !== null && leg.pages.complete
    && leg.pages.rangeStart <= cutoff - days * DAY && leg.pages.rangeEnd >= cutoff;
}

/** Latest complete range for this window, never a splice across cutoffs. */
export function windowEvidence(cached: CachedHistoryLeg, days: HistoryDays): HistoryWindowEvidence {
  return historyReads(cached).filter((read) => coversHistoryWindow(read, days)).sort(compareHistoryEvidence)[0]
    ?? { cutoff: cached.cutoff, leg: windowLeg(cached, cached.cutoff, days) };
}

/**
 * The window's evidence as of `cutoff`: `windowEvidence`, moved to `cutoff` when
 * the refresher found nothing settled since its read. `cutoff` is then the
 * window's end and `carry` names the read's own cutoff.
 */
export function carriedEvidence(cached: CachedHistoryLeg, days: HistoryDays, cutoff: number): HistoryWindowEvidence & { carry?: HistoryCarry } {
  const read = windowEvidence(cached, days);
  const c = cached.carried;
  if (!c || c.cutoff !== cutoff || c.from !== read.cutoff || !carryCovers(c, cutoff)) return read;
  return { cutoff, leg: read.leg, carry: { from: c.from, next: c.next } };
}

export interface HistorySnapshot {
  id: string;
  /** Common cutoff of every comparable result in this snapshot. */
  cutoff: number;
  publishedAt: number;
  legs: ReadonlyMap<string, CachedHistoryLeg>;
  /** Loaded from the local cache at startup, as saved at `savedAt`; no round has published since. */
  restored?: { savedAt: number };
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
  /** `unchanged`: no leg was due and nothing moved, so the published snapshot stands. */
  outcome: 'published' | 'unchanged' | 'failed';
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

/** The local history cache: what startup restored, and how the latest save went. */
export interface HistoryPersistenceView {
  restore: { at: number; outcome: 'restored' | 'empty' | 'discarded' | 'unavailable'; reason?: string; legs?: number } | null;
  lastSave: { at: number; outcome: 'saved' | 'failed'; reason?: string } | null;
}

export type HistoryCacheView =
  | { state: 'cold'; snapshotId: null; cutoff: null; cutoffBehind: null; publishedAt: null; restored: null;
    refreshing: boolean; lastRound: HistoryRoundReport | null; persistence: HistoryPersistenceView }
  | { state: 'ready'; snapshotId: string; cutoff: number; cutoffBehind: boolean; publishedAt: number;
    restored: { savedAt: number } | null;
    refreshing: boolean; lastRound: HistoryRoundReport | null; persistence: HistoryPersistenceView };

export type HistoryAdmission =
  | { admitted: true; result: FundingHistoryResult }
  | { admitted: false; reason: 'history-cold-start' | 'history-snapshot-superseded'
    | 'history-cutoff-behind' | 'history-leg-missing' | 'history-restored' | 'history-ineligible'; result?: FundingHistoryResult };

export class FundingHistoryCache {
  private current: HistorySnapshot | null = null;
  private round: HistoryRoundReport | null = null;
  private running = false;
  private persistence: HistoryPersistenceView = { restore: null, lastSave: null };

  snapshot(): HistorySnapshot | null {
    return this.current;
  }

  /** Refresher only. */
  setRefreshing(running: boolean): void {
    this.running = running;
  }

  /** Startup only: shows the saved snapshot until the first round publishes; never replaces a published one. */
  restore(snapshot: HistorySnapshot & { restored: { savedAt: number } }): void {
    if (!this.current) this.current = snapshot;
  }

  setPersistence(change: Partial<HistoryPersistenceView>): void {
    this.persistence = { ...this.persistence, ...change };
  }

  /** Refresher only: swaps the whole snapshot at once, so no reader sees a half-built round. */
  publish(snapshot: HistorySnapshot | null, report: HistoryRoundReport): void {
    if (snapshot) this.current = snapshot;
    this.round = report;
  }

  view(now: number): HistoryCacheView {
    const snap = this.current;
    if (!snap) {
      return { state: 'cold', snapshotId: null, cutoff: null, cutoffBehind: null, publishedAt: null, restored: null,
        refreshing: this.running, lastRound: this.round, persistence: this.persistence };
    }
    return { state: 'ready', snapshotId: snap.id, cutoff: snap.cutoff, cutoffBehind: snap.cutoff < snapshotCutoff(now),
      publishedAt: snap.publishedAt, restored: snap.restored ?? null, refreshing: this.running, lastRound: this.round,
      persistence: this.persistence };
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
    const a = carriedEvidence(short, pair.days, snap.cutoff);
    const b = carriedEvidence(long, pair.days, snap.cutoff);
    const cutoff = a.cutoff === b.cutoff && a.cutoff <= snap.cutoff ? a.cutoff : snap.cutoff;
    return evaluateFundingHistory({ snapshotId: snap.id, underlying: pair.underlying, cutoff, days: pair.days,
      short: a.cutoff === cutoff ? a.leg : windowLeg(short, cutoff, pair.days),
      long: b.cutoff === cutoff ? b.leg : windowLeg(long, cutoff, pair.days), now,
      carry: { ...(a.cutoff === cutoff && a.carry ? { short: a.carry } : {}), ...(b.cutoff === cutoff && b.carry ? { long: b.carry } : {}) } });
  }

  /** Server-side history admission: the caller's snapshot must still be current, at the current cutoff, and eligible now. */
  recheck(request: HistoryPairRequest & { snapshotId: string }, now: number): HistoryAdmission {
    const snap = this.current;
    if (!snap) return { admitted: false, reason: 'history-cold-start' };
    if (snap.id !== request.snapshotId) return { admitted: false, reason: 'history-snapshot-superseded' };
    if (snap.cutoff !== snapshotCutoff(now)) return { admitted: false, reason: 'history-cutoff-behind' };
    const result = this.evaluate(request, now);
    if (!result) return { admitted: false, reason: 'history-leg-missing' };
    if (result.short.restored || result.long.restored) return { admitted: false, reason: 'history-restored', result };
    if (!result.historyEligible || result.cutoff !== snap.cutoff) return { admitted: false, reason: 'history-ineligible', result };
    return { admitted: true, result };
  }
}
