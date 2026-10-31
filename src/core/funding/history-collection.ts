/** Resumable bounded collection; only completed segments are published as evidence. */
import type { FundingHistorySource, HistoryCall, HistoryBudget } from './history-collector';
import type { HistoryLegKey, HistoryStopReason, HistoryAttemptReason } from './history-cache';
import { HISTORY_DAYS, type FundingHistoryLeg, type HistoryPages, type SettledFundingEvent } from './history';
import { normalizeOfficialSettlement, sourceBoundary } from './history-sources';
import { inferSettlementHour } from './cadence-inference';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class RoundStop extends Error {
  constructor(readonly reason: HistoryStopReason) {
    super(reason);
  }
}


/** Bounds a read even when the source ignores the abort signal. */
export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number,
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


export function placeholder(key: HistoryLegKey, source: FundingHistorySource | undefined): FundingHistoryLeg {
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
function segments(cutoff: number, maxDays: number, listingAt: number | null, initialDays = 7): Array<{ start: number; end: number }> {
  if (!Number.isSafeInteger(initialDays) || initialDays < 7 || initialDays > 30) throw new Error('invalid-initial-history-days');
  const out: Array<{ start: number; end: number }> = [];
  let end = cutoff;
  const windows = [...new Set([Math.min(initialDays, maxDays), ...HISTORY_DAYS.slice(1)])];
  for (const days of windows) {
    if (maxDays < 7) break;
    if (days > maxDays) break;
    const start = cutoff - days * DAY;
    out.push({ start, end });
    if (listingAt !== null && listingAt > start) break;
    end = start;
  }
  return out;
}

export interface CollectionProgress {
  cutoff: number;
  leg: FundingHistoryLeg;
  ranges: Array<{ start: number; end: number }> | null;
  segment: number;
  cursor: string | null;
  pageNo: number;
  covered: number;
  events: SettledFundingEvent[];
  pages: HistoryPages['pages'];
  observedAt: number | null;
  verifiedAt: number | null;
  done: boolean;
}

export async function collectLeg(key: HistoryLegKey, source: FundingHistorySource, call: HistoryCall,
  state: { cutoff: number; hardStop: number }, budget: HistoryBudget, inferCadence = false,
  saved?: CollectionProgress, recentOnly = false) {
  const work: CollectionProgress = saved ?? { cutoff: state.cutoff, leg: placeholder(key, source), ranges: null,
    segment: 0, cursor: null, pageNo: 0, covered: state.cutoff, events: [], pages: [],
    observedAt: null, verifiedAt: null, done: false };
  let reason: HistoryAttemptReason | null = null;
  try {
    const bounded = <T>(run: () => Promise<T>) => withTimeout(run, Math.max(0, state.hardStop - Date.now()), 'deadline');
    const context = await bounded(() => source.context(key.contractId, call));
    if (!context) throw new Error('schedule-unverified');
    work.leg.listing = context.listing;
    work.leg.rules = context.rules;
    work.leg.source = { ...work.leg.source, reason: context.proofRejected };
    work.ranges ??= segments(work.cutoff, source.maxDays ?? 365, context.listing?.at ?? null, source.initialReadDays);
    const ruleAt = (t: number) => context.rules.find((r) => r.from <= t && t < r.until);
    const ref = { venue: source.venue, api: source.api, contractId: key.contractId };
    const stop = recentOnly ? Math.min(1, work.ranges.length) : work.ranges.length;
    while (work.segment < stop) {
      const seg = work.ranges[work.segment]!;
      if (work.pageNo >= budget.maxPagesPerSegment) throw new RoundStop('page-limit');
      let request = '';
      const page = await bounded(() => source.page(key.contractId, seg, work.cursor, (req, run) => {
        request = req;
        return call(req, run);
      }));
      if (!page.done && (page.cursor === null || page.cursor === work.cursor)) throw new RoundStop('pagination-stalled');
      const evidence = `${request}#${page.rawHash}`;
      const events: SettledFundingEvent[] = [];
      for (const row of page.rows) {
        const mapping = source.timeMapping?.(row);
        const at = normalizeOfficialSettlement(ref, row, null, evidence, mapping)?.settledAt;
        const rule = at === undefined ? undefined : ruleAt(at);
        const normalized = normalizeOfficialSettlement(ref, row, rule?.everyHours ?? null, evidence, mapping);
        if (!normalized) throw new RoundStop('settlement-unnormalized');
        const event = inferCadence ? inferSettlementHour(normalized) : normalized;
        if (event.settledAt > seg.start && event.settledAt <= seg.end) events.push(event);
      }
      work.observedAt ??= Date.now();
      work.events.push(...events);
      work.pages.push({ request, firstAt: page.firstAt, lastAt: page.lastAt, count: page.rows.length, cursor: page.cursor, rawHash: page.rawHash });
      work.pageNo += 1;
      work.cursor = page.cursor;
      if (page.done) {
        work.covered = seg.start;
        work.verifiedAt = Date.now();
        work.segment += 1;
        work.cursor = null;
        work.pageNo = 0;
      }
    }
    work.done = work.segment === work.ranges.length;
  } catch (err) {
    reason = err instanceof RoundStop ? err.reason : err instanceof Error && err.message === 'schedule-unverified'
      ? 'schedule-unverified' : 'source-error';
  }
  const leg = work.verifiedAt === null ? { ...work.leg, observedAt: work.observedAt, events: [...work.events],
    pages: { ...work.leg.pages, pages: [...work.pages] } } : {
    ...work.leg, observedAt: work.observedAt, verifiedAt: work.verifiedAt,
    events: [...work.events],
    pages: { complete: true, rangeStart: work.covered, rangeEnd: work.cutoff, pages: [...work.pages],
      termination: reason ? `stopped:${reason}` : recentOnly ? 'recent-segment-done' : 'all-segments-done' },
  };
  return { leg, reason, progress: work };
}
