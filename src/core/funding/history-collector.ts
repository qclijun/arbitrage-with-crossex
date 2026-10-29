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
  type HistoryStopReason,
  type HistoryVenueReport,
} from './history-cache';
import { HISTORY_DAYS, snapshotCutoff, type FundingHistoryLeg, type FundingRuleSegment,
  type HistoryPages, type SettledFundingEvent } from './history';
import { normalizeOfficialSettlement, sourceBoundary } from './history-sources';

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
  /** Proven listing time and historical cadence; null when they cannot be proven (UNKNOWN, no page reads). */
  context(contractId: string, call: HistoryCall): Promise<{ listing: FundingHistoryLeg['listing']; rules: FundingRuleSegment[] } | null>;
  /** One page of settled history in (range.start, range.end]. */
  page(contractId: string, range: { start: number; end: number }, cursor: string | null, call: HistoryCall): Promise<HistorySourcePage>;
  /** Proven settlement hour for a raw row stamped off the hour (Hyperliquid). */
  timeMapping?(row: Record<string, unknown>): { settlementAt: number; evidence: string } | undefined;
}

/** A venue said "slow down" in any form (429, ban, insufficient weight): stop it for the round. */
export class HistoryRateLimitError extends Error {
  constructor(message = 'history-rate-limit', readonly retryAfterMs?: number) { super(message); }
}

class RoundStop extends Error {
  constructor(readonly reason: HistoryStopReason) {
    super(reason);
  }
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

/** Bounds a read even when the source ignores the abort signal. */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number,
  reason: HistoryStopReason = 'timeout'): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new RoundStop(reason));
    }, ms);
  });
  try {
    return await Promise.race([run(abort.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function makeCall(state: RoundState, venue: string, budget: HistoryBudget, random: () => number): HistoryCall {
  const v = state.venues.get(venue)!;
  const spacing = VENUE_SPACING_MS[venue] ?? DEFAULT_SPACING_MS;
  return async (_request, run) => {
    let failure: HistoryStopReason = 'error';
    for (let attempt = 0; attempt <= budget.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const [low, high] = budget.retryJitterMs;
        await sleep(low + Math.floor(random() * (high - low)));
      }
      const wait = v.nextAt - Date.now();
      v.nextAt = Math.max(Date.now(), v.nextAt) + spacing;
      if (wait > 0) await sleep(wait);
      if (!v.stopped && Date.now() >= state.deadline) v.stopped = 'deadline';
      if (!v.stopped && (state.globalLeft <= 0 || v.left <= 0)) v.stopped = 'budget-exhausted';
      if (v.stopped) throw new RoundStop(v.stopped);
      state.globalLeft -= 1;
      v.left -= 1;
      v.requests += 1;
      state.requests += 1;
      try {
        return await withTimeout(run, budget.timeoutMs);
      } catch (err) {
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

function placeholder(key: HistoryLegKey, source: FundingHistorySource | undefined): FundingHistoryLeg {
  return {
    venue: key.venue, contractId: key.contractId,
    source: source
      ? { kind: 'settled-history', api: source.api, version: source.version, status: sourceBoundary(source.venue, source.api, 7) }
      : { kind: 'settled-history', api: '', version: '', status: 'unknown', reason: 'no-history-source' },
    observedAt: null, verifiedAt: null, lastAttempt: null, listing: null,
    pages: { complete: false, rangeStart: 0, rangeEnd: 0, pages: [], termination: '' }, rules: [], events: [],
  };
}

/** Window segments newest first, so a budget cut still proves the short windows. */
function segments(cutoff: number, maxDays: number, listingAt: number | null): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let end = cutoff;
  for (const days of HISTORY_DAYS) {
    if (days > maxDays) break;
    const start = cutoff - days * DAY;
    out.push({ start, end });
    if (listingAt !== null && listingAt > start) break;
    end = start;
  }
  return out;
}

async function collectLeg(key: HistoryLegKey, source: FundingHistorySource, call: HistoryCall, state: RoundState,
  budget: HistoryBudget): Promise<{ leg: FundingHistoryLeg; reason: HistoryAttemptReason | null }> {
  const leg = placeholder(key, source);
  let observedAt: number | null = null;
  const events: SettledFundingEvent[] = [];
  const pages: HistoryPages['pages'] = [];
  let covered = state.cutoff;
  let reason: HistoryAttemptReason | null = null;
  try {
    // Adapter work outside `call` is bounded too, so a hung source cannot pin the round open.
    const bounded = <T>(run: () => Promise<T>) => withTimeout(run, Math.max(0, state.hardStop - Date.now()), 'deadline');
    const context = await bounded(() => source.context(key.contractId, call));
    if (!context) return { leg, reason: 'schedule-unverified' };
    leg.listing = context.listing;
    leg.rules = context.rules;
    if (!context.rules.length) return { leg, reason: 'schedule-unverified' };
    const ruleAt = (t: number) => context.rules.find((r) => r.from <= t && t < r.until);
    const ref = { venue: source.venue, api: source.api, contractId: key.contractId };
    for (const seg of segments(state.cutoff, source.maxDays ?? 365, context.listing?.at ?? null)) {
      let cursor: string | null = null;
      for (let pageNo = 0; ; pageNo += 1) {
        if (pageNo >= budget.maxPagesPerSegment) throw new RoundStop('page-limit');
        let request = '';
        const page = await bounded(() => source.page(key.contractId, seg, cursor, (req, run) => {
          request = req;
          return call(req, run);
        }));
        observedAt ??= Date.now();
        pages.push({ request, firstAt: page.firstAt, lastAt: page.lastAt, count: page.rows.length, cursor: page.cursor, rawHash: page.rawHash });
        const evidence = `${request}#${page.rawHash}`;
        for (const row of page.rows) {
          const mapping = source.timeMapping?.(row);
          // The rule (and so the interval) is chosen by the settlement time it parses to.
          const at = normalizeOfficialSettlement(ref, row, 1, evidence, mapping)?.settledAt;
          const rule = at === undefined ? undefined : ruleAt(at);
          const event = rule ? normalizeOfficialSettlement(ref, row, rule.everyHours, evidence, mapping) : null;
          if (!event) throw new RoundStop('settlement-unnormalized');
          if (event.settledAt > seg.start && event.settledAt <= seg.end) events.push(event);
        }
        if (page.done) break;
        if (page.cursor === null || page.cursor === cursor) throw new RoundStop('pagination-stalled');
        cursor = page.cursor;
      }
      covered = seg.start;
    }
  } catch (err) {
    // A source that throws outside `call` is a broken adapter: this leg fails, the round goes on.
    reason = err instanceof RoundStop ? err.reason : 'source-error';
  }
  if (covered === state.cutoff) return { leg, reason: reason ?? 'no-history-read' };
  Object.assign(leg, {
    observedAt, verifiedAt: Date.now(), events,
    pages: { complete: true, rangeStart: covered, rangeEnd: state.cutoff, pages,
      termination: reason ? `stopped:${reason}` : 'all-segments-done' },
  });
  return { leg, reason };
}

/**
 * Earlier reads of settlements the new read returned differently. Revision rules
 * are unproven (07), so the evaluator sees both variants and holds them as a
 * conflict instead of the new read silently overwriting the old one.
 */
function revised(prior: SettledFundingEvent[], fresh: SettledFundingEvent[]): SettledFundingEvent[] {
  const read = new Map<string, SettledFundingEvent[]>();
  for (const event of fresh) read.set(`${event.settledAt}:${event.kind}`, [...(read.get(`${event.settledAt}:${event.kind}`) ?? []), event]);
  return prior.filter((old) => read.get(`${old.settledAt}:${old.kind}`)
    ?.every((now) => now.rate !== old.rate || now.intervalHours !== old.intervalHours));
}

/**
 * Always adopt a verified read: it is the freshest proof of the windows it covers.
 * An older read at the same cutoff that reaches further back stays as `wider`, so
 * the long windows keep their evidence (and its original verification time).
 * Legs from an older cutoff are dropped, never spliced into the new one.
 */
function merge(prior: CachedHistoryLeg | undefined, fresh: FundingHistoryLeg, cutoff: number,
  at: number, reason: HistoryAttemptReason | null): CachedHistoryLeg {
  const lastAttempt: FundingHistoryLeg['lastAttempt'] = reason ? { at, outcome: 'error', reason } : { at, outcome: 'success' };
  const priorWidest = prior?.cutoff === cutoff ? prior.wider ?? prior.leg : undefined;
  if (fresh.verifiedAt !== null) {
    const leg = { ...fresh, events: [...fresh.events, ...revised(prior?.leg.events ?? [], fresh.events)], lastAttempt };
    if (!priorWidest || priorWidest.verifiedAt === null || fresh.pages.rangeStart <= priorWidest.pages.rangeStart) {
      return { cutoff, leg };
    }
    return { cutoff, leg, wider: { ...priorWidest, events: [...priorWidest.events, ...revised(fresh.events, priorWidest.events)],
      lastAttempt } };
  }
  if (prior) {
    return { cutoff: prior.cutoff, leg: { ...prior.leg, lastAttempt },
      ...(prior.wider ? { wider: { ...prior.wider, lastAttempt } } : {}) };
  }
  return { cutoff, leg: { ...fresh, lastAttempt } };
}

function failedReport(startedAt: number, reason: NonNullable<HistoryRoundReport['reason']>): HistoryRoundReport {
  return { startedAt, finishedAt: Date.now(), cutoff: snapshotCutoff(startedAt), outcome: 'failed', reason, requests: 0, venues: {} };
}

export interface FundingHistoryRefresherDeps {
  cache: FundingHistoryCache;
  sources: FundingHistorySource[];
  /** The current CrossEx live contracts, mapped to venue-native IDs. */
  legs(): Promise<HistoryLegKey[]>;
  budget?: Partial<HistoryBudget>;
  random?: () => number;
}

export function createFundingHistoryRefresher(deps: FundingHistoryRefresherDeps) {
  const budget: HistoryBudget = { ...HISTORY_BUDGET, ...deps.budget };
  const sources = new Map(deps.sources.map((s) => [s.venue, s]));
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
      const verified = (key: HistoryLegKey) => prior?.get(legKey(key))?.leg.verifiedAt ?? -Infinity;
      const pending = [...queue].sort((a, b) => verified(a) - verified(b));
      const worker = async () => {
        for (let key = pending.shift(); key; key = pending.shift()) {
          const { leg, reason } = await collectLeg(key, source, call, state, budget);
          if (!reason) tally.refreshed += 1;
          const id = legKey(key);
          next.set(id, merge(prior?.get(id), leg, cutoff, Date.now(), reason));
        }
      };
      await Promise.all(Array.from({ length: budget.venueConcurrency }, worker));
    }));
    snapshotSeq += 1;
    const finished: HistoryRoundReport = { startedAt, finishedAt: Date.now(), cutoff, outcome: 'published', requests: state.requests,
      venues: Object.fromEntries([...state.venues].map(([venue, { left: _l, nextAt: _n, ...tally }]) => [venue, tally])) };
    deps.cache.publish({ id: `fh-${cutoff}-${startedAt}-${snapshotSeq}`, cutoff, publishedAt: finished.finishedAt, legs: next }, finished);
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
