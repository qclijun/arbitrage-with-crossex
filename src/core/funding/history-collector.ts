/**
 * Bounded background collection of settled funding history into the read-only
 * cache. Every venue read goes through one budgeted `call`, so requests,
 * concurrency, timeouts and retries are capped per round; what does not fit is
 * reported, never promised. Venue IO lives behind `FundingHistorySource` ports.
 */
import {
  FundingHistoryCache,
  legKey,
  type CachedHistoryLeg,
  type HistoryAttemptReason,
  type HistoryLegKey,
  type HistoryRoundReport,
  type HistorySnapshot,
  type HistoryStopReason,
  type HistoryVenueReport,
} from './history-cache';
import { snapshotCutoff, type FundingHistoryLeg, type FundingRuleSegment } from './history';
import { collectLeg, placeholder, RoundStop, withTimeout, type CollectionProgress } from './history-collection';
import { inferFundingCadence } from './cadence-inference';
import { mergeHistoryLeg as merge, retainHistoryLeg } from './history-merge';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Internal per-round guards from 07's research — not venue capacity promises.
 * Lower venue limits apply through `VENUE_SPACING_MS`: OKX 10 req/2 s per IP and
 * contract; Hyperliquid 1200 weight/min with weight growing with response size.
 */
export const HISTORY_BUDGET = {
  /**
   * Interval plus a round's hard stop stays under the 15-minute freshness limit,
   * so a leg re-read every round is never stale while the next round runs.
   */
  intervalMs: 10 * MINUTE,
  /** Rounds start this long after each interval, so the hour's settlement has posted. */
  offsetMs: MINUTE,
  deadlineMs: 4 * MINUTE,
  globalRequests: 240,
  venueRequests: 40,
  venueConcurrency: 2,
  timeoutMs: 5_000,
  maxRetries: 1,
  retryJitterMs: [250, 1_000] as const,
  maxPagesPerSegment: 50,
};
export type HistoryBudget = typeof HISTORY_BUDGET;

/** Minimum gap between request starts per venue; a venue whose limit 07 could not find gets the slow default. */
export const VENUE_SPACING_MS: Record<string, number> = { BINANCE: 0, BYBIT: 0, OKX: 250, HYPERLIQUID: 2_500 };
const DEFAULT_SPACING_MS = 1_000;

/**
 * Budgeted venue read: `request` is the canonical request recorded as evidence.
 * `run` must honour the abort signal, or a timed-out read still occupies the venue.
 * Throw `HistoryRateLimitError` (or an error with `response.status` 429/418) to stop the venue.
 */
export type HistoryCall = <T>(request: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export interface HistorySourcePage {
  rows: Array<Record<string, unknown>>;
  rawHash: string;
  firstAt: number | null;
  lastAt: number | null;
  /** Next-page cursor; required unless `done`. */
  cursor: string | null;
  /** The source proved no further rows exist in the requested range. */
  done: boolean;
}

export interface FundingHistorySource {
  venue: string;
  api: string;
  version: string;
  /** Longest window the endpoint can serve, when shorter than a year. */
  maxDays?: number;
  /** Optional first segment, at least 7 and at most 30 days; still proves the 7d window first. */
  initialReadDays?: number;
  /** Known contract context. Missing listing/cadence blocks eligibility, but not collection of actual rates. */
  context(contractId: string, call: HistoryCall): Promise<{ listing: FundingHistoryLeg['listing']; rules: FundingRuleSegment[];
    proofRejected?: 'historical-policy-changed' } | null>;
  /** One page of settled history in (range.start, range.end]. */
  page(contractId: string, range: { start: number; end: number }, cursor: string | null, call: HistoryCall): Promise<HistorySourcePage>;
  /** Settlement hour and evidence for an off-hour processing timestamp (HL/Aster). */
  timeMapping?(row: Record<string, unknown>): { settlementAt: number; evidence: string } | undefined;
}

/** A venue said "slow down" in any form (429, ban, insufficient weight): stop it for the round. */
export class HistoryRateLimitError extends Error {
  constructor(message = 'history-rate-limit', readonly retryAfterMs?: number) { super(message); }
}

/** A local preflight reservation did not send a request; wait without consuming the wire budget. */
export class HistoryQuotaWaitError extends HistoryRateLimitError {
  constructor(readonly waitMs: number) { super('public-quota-wait', waitMs); }
}


interface RoundState {
  cutoff: number;
  /** No request starts after this. */
  deadline: number;
  /** Nothing of the round runs past this: the deadline plus one request's worst case. */
  hardStop: number;
  globalLeft: number;
  requests: number;
  venues: Map<string, VenueState>;
}

type VenueState = HistoryVenueReport & { left: number; nextAt: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 429, and Binance's 418 IP ban: stop the venue for the round rather than retry into it. */
function rateLimited(err: unknown): boolean {
  if (err instanceof HistoryRateLimitError) return true;
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return status === 429 || status === 418;
}


function makeCall(state: RoundState, venue: string, budget: HistoryBudget, random: () => number): HistoryCall {
  const v = state.venues.get(venue)!;
  const spacing = VENUE_SPACING_MS[venue] ?? DEFAULT_SPACING_MS;
  const checkBudget = () => {
    if (!v.stopped && Date.now() >= state.deadline) v.stopped = 'deadline';
    if (!v.stopped && (state.globalLeft <= 0 || v.left <= 0)) v.stopped = 'budget-exhausted';
    if (v.stopped) throw new RoundStop(v.stopped);
  };
  return async (_request, run) => {
    let failure: HistoryStopReason = 'error';
    for (let attempt = 0; attempt <= budget.maxRetries; attempt += 1) {
      checkBudget();
      if (attempt > 0) {
        const [low, high] = budget.retryJitterMs;
        await sleep(low + Math.floor(random() * (high - low)));
      }
      const wait = v.nextAt - Date.now();
      v.nextAt = Math.max(Date.now(), v.nextAt) + spacing;
      if (wait > 0) await sleep(wait);
      checkBudget();
      state.globalLeft -= 1;
      v.left -= 1;
      v.requests += 1;
      state.requests += 1;
      try {
        return await withTimeout(run, budget.timeoutMs);
      } catch (err) {
        if (err instanceof HistoryQuotaWaitError) {
          // The public reader rejected before HTTP. Keep both the request and
          // retry allowances, then wait inside the round's existing deadline.
          state.globalLeft += 1; v.left += 1; state.requests -= 1; v.requests -= 1;
          if (v.stopped === 'budget-exhausted' && state.globalLeft > 0 && v.left > 0) v.stopped = null;
          if (!Number.isFinite(err.waitMs) || err.waitMs <= 0) throw new RoundStop('error');
          if (Date.now() + err.waitMs >= state.deadline) {
            v.stopped = 'deadline'; throw new RoundStop('deadline');
          }
          await sleep(err.waitMs);
          attempt -= 1;
          continue;
        }
        if (rateLimited(err)) {
          v.stopped = 'rate-limited';
          throw new RoundStop('rate-limited');
        }
        failure = err instanceof RoundStop ? err.reason : 'error';
      }
    }
    throw new RoundStop(failure);
  };
}


function failedReport(startedAt: number, reason: NonNullable<HistoryRoundReport['reason']>): HistoryRoundReport {
  return { startedAt, finishedAt: Date.now(), cutoff: snapshotCutoff(startedAt), outcome: 'failed', reason, requests: 0, venues: {} };
}

export interface FundingHistoryRefresherDeps {
  /** Production accepts explicitly labelled data-derived schedules. Strict callers can omit this. */
  inferCadence?: boolean;
  cache: FundingHistoryCache;
  sources: FundingHistorySource[];
  /** The current CrossEx live contracts, mapped to venue-native IDs. */
  legs(): Promise<HistoryLegKey[]>;
  budget?: Partial<HistoryBudget>;
  random?: () => number;
  /** Reserve the bounded budget for dashboard assets first; equal-priority legs still rotate. */
  priority?(key: HistoryLegKey): number;
  /**
   * Called after each published round. The jobs keep changing in place, so the
   * callee copies what it keeps (`captureHistory`); a throw never fails the round.
   */
  persist?(snapshot: HistorySnapshot, progress: ReadonlyMap<string, CollectionProgress>, backfilled: ReadonlyMap<string, number>): void;
}

export function createFundingHistoryRefresher(deps: FundingHistoryRefresherDeps) {
  const budget: HistoryBudget = { ...HISTORY_BUDGET, ...deps.budget };
  const sources = new Map(deps.sources.map((s) => [s.venue, s]));
  const progress = new Map<string, CollectionProgress>();
  const backfilled = new Map<string, number>();
  let snapshotSeq = 0;
  let inflight: Promise<HistoryRoundReport> | null = null;

  async function round(): Promise<HistoryRoundReport> {
    const startedAt = Date.now();
    const cutoff = snapshotCutoff(startedAt);
    const deadline = startedAt + budget.deadlineMs;
    const hardStop = deadline + (budget.maxRetries + 1) * budget.timeoutMs + budget.maxRetries * budget.retryJitterMs[1];
    const state: RoundState = { cutoff, deadline, hardStop, globalLeft: budget.globalRequests, requests: 0, venues: new Map() };
    let keys: HistoryLegKey[];
    try {
      keys = await withTimeout(() => deps.legs(), budget.timeoutMs);
    } catch {
      return failedReport(startedAt, 'leg-list-failed');
    }
    const prior = deps.cache.snapshot()?.legs;
    const live = new Set(keys.map(legKey));
    for (const id of progress.keys()) if (!live.has(id) || progress.get(id)!.cutoff > cutoff) { progress.delete(id); backfilled.delete(id); }
    const next = new Map<string, CachedHistoryLeg>();
    const byVenue = new Map<string, HistoryLegKey[]>();
    for (const key of new Map(keys.map((k) => [legKey(k), k])).values()) {
      if (sources.has(key.venue)) byVenue.set(key.venue, [...(byVenue.get(key.venue) ?? []), key]);
      else next.set(legKey(key), merge(prior?.get(legKey(key)), placeholder(key, undefined), cutoff, startedAt, 'no-history-source'));
    }
    await Promise.all([...byVenue].map(async ([venue, queue]) => {
      const tally: VenueState = { requests: 0, legs: queue.length, refreshed: 0, stopped: null, left: budget.venueRequests, nextAt: 0 };
      state.venues.set(venue, tally);
      const source = sources.get(venue)!;
      const call = makeCall(state, venue, budget, deps.random ?? Math.random);
      // Least recently verified first, so a budget cut rotates instead of starving the same legs.
      // A restored read is never fresh, so it waits with the never-read ones, not behind fresh legs.
      const verified = (key: HistoryLegKey) => {
        const leg = prior?.get(legKey(key))?.leg;
        return leg?.restored ? -Infinity : leg?.verifiedAt ?? -Infinity;
      };
      const pending = [...queue].sort((a, b) => (deps.priority?.(b) ?? 0) - (deps.priority?.(a) ?? 0)
        || verified(a) - verified(b) || legKey(a).localeCompare(legKey(b)));
      const process = async (key: HistoryLegKey, recentOnly = false) => {
        const id = legKey(key);
        const staged = venue === 'HYPERLIQUID';
        const saved = staged && !recentOnly ? progress.get(id) : undefined;
        const before = tally.requests;
        const collected = await collectLeg(key, source, call, state, budget, deps.inferCadence, saved, recentOnly);
        if (staged && (!recentOnly || !progress.has(id) || progress.get(id)!.segment === 0 || progress.get(id)!.done)) {
          progress.set(id, collected.progress);
        }
        if (staged && !recentOnly && tally.requests > before) backfilled.set(id, snapshotSeq + 1);
        const { reason } = collected;
        const leg = deps.inferCadence ? inferFundingCadence(collected.leg) : collected.leg;
        if (!reason && !recentOnly) tally.refreshed += 1;
        const previous = next.get(id) ?? prior?.get(id);
        const entry = staged ? retainHistoryLeg(previous, leg, collected.progress.cutoff, Date.now(), reason, cutoff)
          : merge(previous, leg, collected.progress.cutoff, Date.now(), reason);
        const job = staged ? progress.get(id) : undefined;
        if (job) {
          const pending = job.ranges?.[job.segment];
          entry.backfill = { cutoff: job.cutoff, completeThroughDays: (job.cutoff - job.covered) / DAY,
            pendingDays: pending ? (job.cutoff - pending.start) / DAY : null, pagesRead: job.pages.length };
        }
        next.set(id, entry);
      };
      const workers = async (keys: HistoryLegKey[], recentOnly = false) => {
        const worker = async () => {
          for (let key = keys.shift(); key; key = keys.shift()) await process(key, recentOnly);
        };
        await Promise.all(Array.from({ length: budget.venueConcurrency }, worker));
      };
      if (venue === 'HYPERLIQUID') {
        const tiers = [...new Set(pending.map((key) => deps.priority?.(key) ?? 0))];
        for (const priority of tiers) {
          const tier = pending.filter((key) => (deps.priority?.(key) ?? 0) === priority);
          await workers([...tier], true);
          await workers([...tier].sort((a, b) => (backfilled.get(legKey(a)) ?? 0) - (backfilled.get(legKey(b)) ?? 0)));
        }
      } else await workers(pending);
    }));
    snapshotSeq += 1;
    const finished: HistoryRoundReport = { startedAt, finishedAt: Date.now(), cutoff, outcome: 'published', requests: state.requests,
      venues: Object.fromEntries([...state.venues].map(([venue, { left: _l, nextAt: _n, ...tally }]) => [venue, tally])) };
    const snapshot: HistorySnapshot = { id: `fh-${cutoff}-${startedAt}-${snapshotSeq}`, cutoff, publishedAt: finished.finishedAt, legs: next };
    deps.cache.publish(snapshot, finished);
    try { deps.persist?.(snapshot, progress, backfilled); } catch { /* the cache file is optional; the round stands */ }
    return finished;
  }

  function runOnce(): Promise<HistoryRoundReport> {
    if (inflight) return inflight;
    deps.cache.setRefreshing(true);
    const startedAt = Date.now();
    inflight = round().catch(() => failedReport(startedAt, 'round-error')).then((report) => {
      // A failed round only records why; the last published snapshot stays.
      if (report.outcome === 'failed') deps.cache.publish(null, report);
      return report;
    }).finally(() => {
      inflight = null;
      deps.cache.setRefreshing(false);
    });
    return inflight;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Each interval plus the offset; a round still running absorbs the tick. */
  function schedule(): void {
    const now = Date.now();
    const at = Math.floor((now - budget.offsetMs) / budget.intervalMs) * budget.intervalMs + budget.intervalMs + budget.offsetMs;
    timer = setTimeout(() => {
      void runOnce();
      schedule();
    }, at - now);
    timer.unref?.();
  }

  return {
    runOnce,
    /** Before the first round only: resume saved backfill jobs (still marked `restored`) and their rotation. */
    restore(saved: { progress: ReadonlyMap<string, CollectionProgress>; backfilled: ReadonlyMap<string, number> }): void {
      if (snapshotSeq || inflight) return;
      for (const [id, job] of saved.progress) progress.set(id, job);
      for (const [id, seq] of saved.backfilled) backfilled.set(id, seq);
      snapshotSeq = Math.max(0, ...saved.backfilled.values());
    },
    /** Runs a round now (unless a scheduled one is due within the offset), then on schedule. */
    start(): void {
      if (timer) return;
      if (Date.now() % budget.intervalMs >= budget.offsetMs) void runOnce();
      schedule();
    },
    stop(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
