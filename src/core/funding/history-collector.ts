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
import { lastSettlement, nextSettlement, snapshotCutoff, type FundingHistoryLeg, type FundingRuleSegment } from './history';
import { collectLeg, placeholder, RoundStop, withTimeout, type CollectionProgress } from './history-collection';
import { inferFundingCadence } from './cadence-inference';
import { mergeHistoryLeg as merge, retainHistoryLeg } from './history-merge';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Internal per-round guards from 07's research — not venue capacity promises.
 * Lower venue limits apply through `VENUE_SPACING_MS`: OKX 10 req/2 s per IP and
 * contract; Hyperliquid 1200 weight/min with weight growing with response size;
 * Lighter 60 requests/min per IP across every endpoint.
 */
export const HISTORY_BUDGET = {
  /**
   * How often a round checks which legs are due. A leg is read only when a
   * settlement is due since its last read (or that read failed or is pending),
   * so most rounds send nothing.
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
export const VENUE_SPACING_MS: Record<string, number> = { BINANCE: 0, BYBIT: 0, OKX: 250, HYPERLIQUID: 2_500, LIGHTER: 3_000 };
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
  /**
   * Hourly history read as a resumable backfill: a due round re-reads only the
   * first segment, and the older ones continue across rounds.
   */
  staged?: boolean;
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


/** A venue's own word on a leg's settlement timing, from its current-rate feed. */
export interface SettlementHint { intervalHours: number; nextAt: number | null }

/**
 * Whether a leg needs a read this round. Not due: read at this cutoff already,
 * or nothing has settled since its read — then `carried` proves the read still
 * covers this cutoff. Due: never read, restored, a failed or partial attempt,
 * a read missing the settlement due at its cutoff, an unknown cadence, or a
 * settlement by its cadence or its venue's feed since. `resumes`: the leg has an
 * unfinished staged backfill, which continues by itself, so its failure alone
 * does not repeat a recent read already made at this cutoff.
 */
export function legDue(prior: CachedHistoryLeg | undefined, cutoff: number, hint: SettlementHint | null, now: number,
  resumes = false): { due: true } | { due: false; carried?: NonNullable<CachedHistoryLeg['carried']> } {
  const leg = prior?.leg;
  if (!prior || !leg || leg.restored || leg.verifiedAt === null) return { due: true };
  if (leg.lastAttempt?.outcome !== 'success' && !(resumes && prior.cutoff >= cutoff)) return { due: true };
  // The venue had not posted the settlement at the read's cutoff yet: read until it shows.
  const last = lastSettlement(leg, prior.cutoff);
  if (last !== null && !leg.events.some((event) => event.settledAt === last && event.kind === 'regular')) return { due: true };
  if (prior.cutoff >= cutoff) return { due: false };
  const byRule = nextSettlement(leg, prior.cutoff);
  if (byRule === null) return { due: true };
  const feedNext = hint?.nextAt != null && hint.nextAt > prior.cutoff ? hint.nextAt : null;
  // The feed's last settlement, when it is after the read: the cadence changed under it.
  if (feedNext !== null && feedNext - hint!.intervalHours * 60 * MINUTE > prior.cutoff) return { due: true };
  const next = Math.min(byRule, feedNext ?? Infinity);
  if (next <= cutoff) return { due: true };
  return { due: false, carried: { from: prior.cutoff, cutoff, next, at: now,
    evidence: `next-settlement-v1;rule=${byRule}${feedNext !== null ? `;feed=${feedNext}/${hint!.intervalHours}h` : ''}` } };
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
  /** The venue feeds' current settlement timing, read once per round: a lookup by leg. */
  settlementHints?(): (key: HistoryLegKey) => SettlementHint | null;
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
    const due = new Set<string>();
    const byVenue = new Map<string, HistoryLegKey[]>();
    const hint = deps.settlementHints?.() ?? (() => null);
    let attempted = 0;
    for (const key of new Map(keys.map((k) => [legKey(k), k])).values()) {
      if (sources.has(key.venue)) byVenue.set(key.venue, [...(byVenue.get(key.venue) ?? []), key]);
      else next.set(legKey(key), merge(prior?.get(legKey(key)), placeholder(key, undefined), cutoff, startedAt, 'no-history-source'));
    }
    await Promise.all([...byVenue].map(async ([venue, queue]) => {
      const tally: VenueState = { requests: 0, legs: queue.length, refreshed: 0, stopped: null, left: budget.venueRequests, nextAt: 0 };
      state.venues.set(venue, tally);
      const source = sources.get(venue)!;
      const call = makeCall(state, venue, budget, deps.random ?? Math.random);
      for (const key of queue) {
        const id = legKey(key);
        const resumes = source.staged === true && progress.get(id)?.done === false;
        const verdict = legDue(prior?.get(id), cutoff, hint(key), startedAt, resumes);
        if (verdict.due) due.add(id);
        else next.set(id, verdict.carried ? { ...prior!.get(id)!, carried: verdict.carried } : prior!.get(id)!);
      }
      const isDue = (key: HistoryLegKey) => due.has(legKey(key));
      // Least recently verified first, so a budget cut rotates instead of starving the same legs.
      // A restored read is never fresh, so it waits with the never-read ones, not behind fresh legs.
      const verified = (key: HistoryLegKey) => {
        const leg = prior?.get(legKey(key))?.leg;
        return leg?.restored ? -Infinity : leg?.verifiedAt ?? -Infinity;
      };
      const pending = [...queue].sort((a, b) => verified(a) - verified(b) || legKey(a).localeCompare(legKey(b)));
      const process = async (key: HistoryLegKey, recentOnly = false) => {
        const id = legKey(key);
        attempted += 1;
        const staged = source.staged === true;
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
      if (source.staged) {
        await workers(pending.filter(isDue), true);
        // Due legs start a new job above; a job left unfinished by an earlier round continues.
        await workers(pending.filter((key) => isDue(key) || progress.get(legKey(key))?.done === false)
          .sort((a, b) => (backfilled.get(legKey(a)) ?? 0) - (backfilled.get(legKey(b)) ?? 0)));
      } else await workers(pending.filter(isDue));
    }));
    const venues = Object.fromEntries([...state.venues].map(([venue, { left: _l, nextAt: _n, ...tally }]) => [venue, tally]));
    const before = deps.cache.snapshot();
    // No leg was attempted and none moved: keep the published snapshot (and the previews bound to it).
    // An attempt that failed before sending anything still publishes its failure.
    if (!attempted && before && !before.restored && before.cutoff === cutoff
      && before.legs.size === next.size && [...next.keys()].every((id) => before.legs.has(id))) {
      const unchanged: HistoryRoundReport = { startedAt, finishedAt: Date.now(), cutoff, outcome: 'unchanged', requests: 0, venues };
      deps.cache.publish(null, unchanged);
      return unchanged;
    }
    snapshotSeq += 1;
    const finished: HistoryRoundReport = { startedAt, finishedAt: Date.now(), cutoff, outcome: 'published', requests: state.requests, venues };
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
