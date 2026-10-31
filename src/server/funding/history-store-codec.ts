/**
 * Row encoding for the funding history cache file. Decoding validates every
 * field and throws on the first bad one: a cache that does not read back exactly
 * is discarded whole, never partly trusted.
 */
import type { CachedHistoryLeg } from '../../core/funding/history-cache';
import type { CollectionProgress } from '../../core/funding/history-collection';
import type { FundingHistoryLeg, SettledFundingEvent } from '../../core/funding/history';

/** One saved read of a leg: `leg`, `wider`, `retained:<n>`, or the backfill job `progress`. */
export interface SlotRecord {
  slot: string;
  cutoff: number;
  observedAt: number | null;
  verifiedAt: number | null;
  /** Everything but the records, as JSON; `restored` is never saved, it is re-derived on load. */
  body: string;
  events: SettledFundingEvent[];
}

export interface SettlementRow {
  slot: string;
  settled_at: number;
  raw_time: number | null;
  rate: string;
  interval_hours: number | null;
  status: string;
  kind: string;
  evidence: number;
  time_mapping_evidence: number | null;
}

export class CorruptHistoryCache extends Error {
  constructor(what: string) { super(`history-cache-corrupt: ${what}`); }
}

const legBody = ({ events: _events, restored: _restored, ...rest }: FundingHistoryLeg) => rest;

const readSlot = (slot: string, cutoff: number, leg: FundingHistoryLeg): SlotRecord => ({
  slot, cutoff, observedAt: leg.observedAt, verifiedAt: leg.verifiedAt, body: JSON.stringify(legBody(leg)), events: leg.events,
});

export function encodeLeg(cached: CachedHistoryLeg | undefined, job: CollectionProgress | undefined): SlotRecord[] {
  const out: SlotRecord[] = [];
  if (cached) {
    out.push(readSlot('leg', cached.cutoff, cached.leg));
    if (cached.wider) out.push(readSlot('wider', cached.cutoff, cached.wider));
    cached.retained?.forEach((read, i) => out.push(readSlot(`retained:${i}`, read.cutoff, read.leg)));
  }
  if (job) {
    const { events, leg, ...rest } = job;
    out.push({ slot: 'progress', cutoff: job.cutoff, observedAt: job.observedAt, verifiedAt: job.verifiedAt,
      body: JSON.stringify({ ...rest, leg: { ...legBody(leg), events: leg.events } }), events });
  }
  return out;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown) => Number.isSafeInteger(v);
const intOrNull = (v: unknown) => v === null || int(v);
const str = (v: unknown) => typeof v === 'string';

function check(ok: boolean, what: string): void {
  if (!ok) throw new CorruptHistoryCache(what);
}

function parse(text: string, what: string): unknown {
  try { return JSON.parse(text); } catch { throw new CorruptHistoryCache(`${what} is not JSON`); }
}

function checkLeg(v: unknown, venue: string, contractId: string, what: string): asserts v is Omit<FundingHistoryLeg, 'events'> {
  check(isObject(v) && v.venue === venue && v.contractId === contractId, `${what} identity`);
  const leg = v as Json;
  const source = leg.source;
  check(isObject(source) && source.kind === 'settled-history' && str(source.api) && str(source.version)
    && ['verified', 'unknown', 'unsupported'].includes(source.status as string)
    && (source.reason === undefined || str(source.reason)), `${what} source`);
  check(intOrNull(leg.observedAt) && intOrNull(leg.verifiedAt), `${what} times`);
  const attempt = leg.lastAttempt;
  check(attempt === null || (isObject(attempt) && int(attempt.at) && ['success', 'error'].includes(attempt.outcome as string)
    && (attempt.reason === undefined || str(attempt.reason))), `${what} lastAttempt`);
  const listing = leg.listing;
  check(listing === null || (isObject(listing) && int(listing.at) && str(listing.evidence)), `${what} listing`);
  const pages = leg.pages;
  check(isObject(pages) && typeof pages.complete === 'boolean' && int(pages.rangeStart) && int(pages.rangeEnd)
    && str(pages.termination) && Array.isArray(pages.pages) && pages.pages.every((p) => isObject(p) && str(p.request)
      && str(p.rawHash) && int(p.count) && intOrNull(p.firstAt) && intOrNull(p.lastAt) && (p.cursor === null || str(p.cursor))), `${what} pages`);
  check(Array.isArray(leg.rules) && leg.rules.every((r) => isObject(r) && int(r.from) && int(r.until) && int(r.everyHours)
    && int(r.anchor) && str(r.evidence)), `${what} rules`);
  const cadence = leg.cadence;
  check(cadence === undefined || (isObject(cadence) && ['inferred', 'provided', 'unavailable'].includes(cadence.basis as string)
    && Array.isArray(cadence.intervals) && cadence.intervals.every(int) && int(cadence.samples)), `${what} cadence`);
}

export function decodeStrings(text: string, what: string): string[] {
  const strings = parse(text, `${what} strings`);
  check(Array.isArray(strings) && strings.every(str), `${what} strings`);
  return strings as string[];
}

export function decodeEvent(row: SettlementRow, strings: string[], what: string): SettledFundingEvent {
  check(int(row.settled_at) && intOrNull(row.raw_time) && str(row.rate) && intOrNull(row.interval_hours)
    && (row.status === 'settled' || row.status === 'predicted') && (row.kind === 'regular' || row.kind === 'special')
    && int(row.evidence) && strings[row.evidence] !== undefined
    && (row.time_mapping_evidence === null || (int(row.time_mapping_evidence) && strings[row.time_mapping_evidence] !== undefined)),
  `${what} settlement`);
  return {
    settledAt: row.settled_at, ...(row.raw_time !== null ? { rawTime: row.raw_time } : {}),
    ...(row.time_mapping_evidence !== null ? { timeMappingEvidence: strings[row.time_mapping_evidence] } : {}),
    rate: row.rate, intervalHours: row.interval_hours, status: row.status as SettledFundingEvent['status'],
    kind: row.kind as SettledFundingEvent['kind'], evidence: strings[row.evidence]!,
  };
}

/** A saved read, marked `restored`: shown with its original timestamps, never fresh. */
export function decodeRead(body: string, events: SettledFundingEvent[], venue: string, contractId: string, what: string): FundingHistoryLeg {
  const leg = parse(body, what);
  checkLeg(leg, venue, contractId, what);
  return { ...leg, events, restored: true };
}

export function decodeProgress(body: string, events: SettledFundingEvent[], venue: string, contractId: string): CollectionProgress {
  const job = parse(body, 'progress');
  check(isObject(job), 'progress');
  const { leg, ...rest } = job as Json;
  checkLeg(leg, venue, contractId, 'progress leg');
  const legEvents = (leg as Json).events;
  // The job's own leg holds no records (they live in `events`); kept verbatim all the same.
  check(Array.isArray(legEvents) && legEvents.every(isObject), 'progress leg events');
  check(int(rest.cutoff) && int(rest.segment) && int(rest.pageNo) && int(rest.covered) && typeof rest.done === 'boolean'
    && (rest.cursor === null || str(rest.cursor)) && intOrNull(rest.observedAt) && intOrNull(rest.verifiedAt)
    && (rest.ranges === null || (Array.isArray(rest.ranges) && rest.ranges.every((r) => isObject(r) && int(r.start) && int(r.end))))
    && Array.isArray(rest.pages), 'progress fields');
  return { ...(rest as Omit<CollectionProgress, 'leg' | 'events'>), leg: { ...(leg as FundingHistoryLeg), restored: true }, events };
}

export function decodeBackfill(text: string | null): CachedHistoryLeg['backfill'] {
  if (text === null) return undefined;
  const v = parse(text, 'backfill');
  check(isObject(v) && int(v.cutoff) && typeof v.completeThroughDays === 'number' && int(v.pagesRead)
    && (v.pendingDays === null || typeof v.pendingDays === 'number'), 'backfill');
  return v as CachedHistoryLeg['backfill'];
}
