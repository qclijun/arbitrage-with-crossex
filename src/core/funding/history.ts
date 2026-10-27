/** Pure settled-funding evidence checks. Adapters must supply proven history, never current quotes. */
import { sourceBoundary } from './history-sources';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FRESH_MS = 15 * 60_000;
export const HISTORY_DAYS = [7, 30, 90, 180, 365] as const;
export type HistoryDays = typeof HISTORY_DAYS[number];
export type Coverage = 'complete' | 'partial' | 'unknown' | 'unsupported';

export interface SettledFundingEvent {
  settledAt: number;
  /** Source timestamp before a separately proved settlement-hour mapping. */
  rawTime?: number;
  timeMappingEvidence?: string;
  rate: string;
  intervalHours: number;
  status: 'settled' | 'predicted';
  /** A special economic event can share a timestamp with the regular settlement. */
  kind: 'regular' | 'special';
  evidence: string;
}

export interface FundingRuleSegment {
  /** Effective settlement-time range [from, until). */
  from: number;
  until: number;
  everyHours: number;
  /** A proven settlement time on this segment's cadence. */
  anchor: number;
  evidence: string;
}

export interface HistoryPages {
  /** Collector proves request pagination before setting complete; the evaluator checks its window binding. */
  complete: boolean;
  rangeStart: number;
  rangeEnd: number;
  pages: Array<{ request: string; firstAt: number | null; lastAt: number | null;
    count: number; cursor: string | null; rawHash: string }>;
  termination: string;
}

export interface FundingHistoryLeg {
  venue: string;
  contractId: string;
  source: { kind: 'settled-history'; api: string; version: string;
    status: 'verified' | 'unknown' | 'unsupported'; reason?: string };
  observedAt: number | null;
  verifiedAt: number | null;
  lastAttempt: { at: number; outcome: 'success' | 'error'; reason?: string } | null;
  listing: { at: number; evidence: string } | null;
  pages: HistoryPages;
  rules: FundingRuleSegment[];
  events: SettledFundingEvent[];
}

export interface LegHistoryResult {
  venue: string;
  contractId: string;
  source: FundingHistoryLeg['source'];
  observedAt: number | null;
  verifiedAt: number | null;
  lastAttempt: FundingHistoryLeg['lastAttempt'];
  coverage: Coverage;
  fresh: boolean;
  reasons: string[];
  missingEvents: number[];
  missingRanges: Array<{ start: number; end: number; reason: string }>;
  conflicts: Array<{ settledAt: number; kind: SettledFundingEvent['kind']; variants: SettledFundingEvent[] }>;
  specialEvents: SettledFundingEvent[];
  total: string | null;
  annualized: string | null;
}

export interface FundingHistoryResult {
  snapshotId: string;
  underlying: string;
  cutoff: number;
  start: number;
  days: HistoryDays;
  short: LegHistoryResult;
  long: LegHistoryResult;
  coverage: Coverage;
  fresh: boolean;
  historyEligible: boolean;
  executionBlockers: string[];
  netTotal: string | null;
  netAnnualized: string | null;
  /** Independent execution checks (fees, units, whitelist, balance) belong to the caller. */
}

export function snapshotCutoff(now: number): number {
  if (!Number.isSafeInteger(now)) throw new Error('Invalid snapshot time');
  return Math.floor(now / HOUR) * HOUR;
}

export interface Decimal { coefficient: bigint; places: number }

export function parseDecimal(value: string): Decimal | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const places = match[3]?.length ?? 0;
  return { coefficient: BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`), places };
}

export function scale(value: Decimal, places: number): bigint {
  return value.coefficient * 10n ** BigInt(places - value.places);
}

function format(coefficient: bigint, places: number): string {
  const sign = coefficient < 0n ? '-' : '';
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(places + 1, '0');
  const whole = places ? digits.slice(0, -places) : digits;
  const fraction = places ? digits.slice(-places).replace(/0+$/, '') : '';
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** `numerator / divisor` (a positive divisor) at `places` decimals, rounded half away from zero. */
export function divideRounded(numerator: bigint, divisor: bigint, places: number): string {
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const rounded = quotient + (2n * (remainder < 0n ? -remainder : remainder) >= divisor
    ? numerator < 0n ? -1n : 1n : 0n);
  return format(rounded, places);
}

function annualized(value: Decimal, days: number): string {
  // Exact totals are kept separately; ranking orders by them, not by this rounded rate.
  const places = Math.max(value.places, 18);
  return divideRounded(scale(value, places) * 365n, BigInt(days), places);
}

function schedule(rules: FundingRuleSegment[], start: number, cutoff: number): number[] | null {
  const sorted = [...rules].sort((a, b) => a.from - b.from);
  if (!sorted.length || sorted[0].from > start) return null;
  const expected: number[] = [];
  let coveredUntil = sorted[0].from;
  for (const rule of sorted) {
    if (rule.from !== coveredUntil || rule.until <= rule.from || !rule.evidence
      || !Number.isSafeInteger(rule.anchor) || !Number.isSafeInteger(rule.everyHours)
      || rule.everyHours <= 0 || !Number.isSafeInteger(rule.from) || !Number.isSafeInteger(rule.until)) return null;
    coveredUntil = rule.until;
    const period = rule.everyHours * HOUR;
    const lower = Math.max(start + 1, rule.from);
    const upper = Math.min(cutoff, rule.until - 1);
    const first = rule.anchor + Math.ceil((lower - rule.anchor) / period) * period;
    for (let time = first; time <= upper; time += period) {
      expected.push(time);
      if (expected.length > 10_000) return null;
    }
    if (coveredUntil > cutoff) break;
  }
  return coveredUntil > cutoff ? expected : null;
}

function evaluateLeg(leg: FundingHistoryLeg, start: number, cutoff: number, now: number, days: HistoryDays): LegHistoryResult {
  const reasons: string[] = [];
  const conflicts: LegHistoryResult['conflicts'] = [];
  const specialEvents: SettledFundingEvent[] = [];
  const missingEvents: number[] = [];
  const missingRanges: LegHistoryResult['missingRanges'] = [];
  const fresh = leg.verifiedAt !== null && leg.verifiedAt <= now
    && leg.verifiedAt >= cutoff && leg.observedAt !== null && leg.observedAt >= cutoff
    && leg.verifiedAt >= leg.observedAt
    && now - leg.verifiedAt <= FRESH_MS && snapshotCutoff(now) === cutoff;
  const base = {
    venue: leg.venue, contractId: leg.contractId, source: leg.source,
    observedAt: leg.observedAt, verifiedAt: leg.verifiedAt, lastAttempt: leg.lastAttempt,
    fresh, reasons, missingEvents, missingRanges, conflicts, specialEvents,
  };
  const boundary = sourceBoundary(leg.venue, leg.source.api, days);
  if (boundary === 'unsupported' || (boundary === 'verified' && leg.source.status === 'unsupported')) {
    return { ...base, coverage: 'unsupported', total: null, annualized: null,
      reasons: [leg.source.reason ?? 'historical-source-unsupported'] };
  }
  if (boundary !== 'verified' || leg.source.status !== 'verified' || !leg.source.version) reasons.push('source-unverified');
  if (!leg.listing?.evidence || leg.listing.at > start) {
    reasons.push('listing-history-insufficient');
    if (leg.listing && leg.listing.at > start) {
      missingRanges.push({ start, end: Math.min(leg.listing.at, cutoff), reason: 'listing-history-insufficient' });
    }
  }
  if (!leg.pages.complete || !leg.pages.termination || leg.pages.rangeStart > start
    || leg.pages.rangeEnd < cutoff || !leg.pages.pages.length
    || leg.pages.pages.some((page) => !page.request || !page.rawHash
      || !Number.isSafeInteger(page.count) || page.count < 0)) reasons.push('page-incomplete');
  if (leg.observedAt === null || leg.verifiedAt === null || leg.observedAt > now
    || leg.verifiedAt > now || leg.observedAt < cutoff || leg.verifiedAt < leg.observedAt) {
    reasons.push('verification-missing');
  }
  const expected = schedule(leg.rules, start, cutoff);
  if (expected === null) reasons.push('schedule-unverified');
  const expectedSet = new Set(expected ?? []);
  const byKey = new Map<string, SettledFundingEvent>();
  const conflictByKey = new Map<string, SettledFundingEvent[]>();
  for (const event of leg.events) {
    if (event.settledAt <= start || event.settledAt > cutoff) continue;
    const key = `${event.settledAt}:${event.kind}`;
    const existing = byKey.get(key);
    const rate = parseDecimal(event.rate);
    if (!rate || event.status !== 'settled' || !Number.isSafeInteger(event.settledAt)
      || !Number.isSafeInteger(event.intervalHours) || (event.kind !== 'regular' && event.kind !== 'special')
      || !event.evidence || (event.rawTime !== undefined && event.rawTime !== event.settledAt
        && !event.timeMappingEvidence)) {
      reasons.push('invalid-settlement');
      continue;
    }
    if (existing) {
      const prior = parseDecimal(existing.rate)!;
      const places = Math.max(prior.places, rate.places);
      if (scale(prior, places) !== scale(rate, places) || existing.intervalHours !== event.intervalHours) {
        const variants = conflictByKey.get(key) ?? [existing];
        variants.push(event);
        conflictByKey.set(key, variants);
      }
    } else byKey.set(key, event);
  }
  for (const time of expected ?? []) if (!byKey.has(`${time}:regular`)) missingEvents.push(time);
  for (const event of byKey.values()) {
    const time = event.settledAt;
    const rule = leg.rules.find((item) => item.from <= time && time < item.until);
    if (event.kind === 'special') {
      specialEvents.push(event);
      // Binance's 2026-07-23 fundingRate changelog defines Special as extra funding.
      // Other venues have no equivalent proven economic type in the source contract.
      if (leg.venue !== 'BINANCE') reasons.push('special-settlement-semantics-unverified');
    }
    if (event.kind === 'regular' && (!expectedSet.has(time) || rule?.everyHours !== event.intervalHours)) {
      reasons.push('settlement-rule-mismatch');
    }
  }
  for (const variants of conflictByKey.values()) {
    conflicts.push({ settledAt: variants[0].settledAt, kind: variants[0].kind, variants });
  }
  if (conflicts.length) reasons.push('settlement-conflict');
  if (missingEvents.length) reasons.push('missing-settlement');
  const coverage: Coverage = conflicts.length || reasons.some((reason) => reason !== 'missing-settlement')
    ? 'unknown' : missingEvents.length ? byKey.size ? 'partial' : 'unknown' : 'complete';
  if (coverage !== 'complete') return { ...base, coverage, total: null, annualized: null };
  const rates = [...byKey.values()].map((event) => parseDecimal(event.rate)!);
  const places = Math.max(0, ...rates.map((rate) => rate.places));
  const amount: Decimal = { coefficient: rates.reduce((sum, rate) => sum + scale(rate, places), 0n), places };
  return { ...base, coverage, total: format(amount.coefficient, places), annualized: annualized(amount, (cutoff - start) / DAY) };
}

export function evaluateFundingHistory(input: {
  snapshotId: string;
  underlying: string;
  cutoff: number;
  days: HistoryDays;
  short: FundingHistoryLeg;
  long: FundingHistoryLeg;
  now: number;
  executionBlockers?: string[];
}): FundingHistoryResult {
  if (!HISTORY_DAYS.includes(input.days) || !Number.isSafeInteger(input.cutoff)
    || input.cutoff % HOUR !== 0 || input.cutoff > snapshotCutoff(input.now)) throw new Error('Invalid history window');
  const start = input.cutoff - input.days * DAY;
  const short = evaluateLeg(input.short, start, input.cutoff, input.now, input.days);
  const long = evaluateLeg(input.long, start, input.cutoff, input.now, input.days);
  const coverage: Coverage = short.coverage === 'complete' && long.coverage === 'complete' ? 'complete'
    : short.coverage === 'unsupported' || long.coverage === 'unsupported' ? 'unsupported'
      : short.coverage === 'unknown' || long.coverage === 'unknown' ? 'unknown' : 'partial';
  const fresh = short.fresh && long.fresh;
  let netTotal: string | null = null;
  let netAnnualized: string | null = null;
  if (coverage === 'complete') {
    const a = parseDecimal(short.total!)!;
    const b = parseDecimal(long.total!)!;
    const places = Math.max(a.places, b.places);
    const amount = { coefficient: scale(a, places) - scale(b, places), places };
    netTotal = format(amount.coefficient, places);
    netAnnualized = annualized(amount, input.days);
  }
  return {
    snapshotId: input.snapshotId, underlying: input.underlying, cutoff: input.cutoff, start,
    days: input.days, short, long, coverage, fresh,
    historyEligible: coverage === 'complete' && fresh,
    executionBlockers: [...(input.executionBlockers ?? [])], netTotal, netAnnualized,
  };
}

export function evaluateFundingWindows(input: Omit<Parameters<typeof evaluateFundingHistory>[0], 'days'>): FundingHistoryResult[] {
  return HISTORY_DAYS.map((days) => evaluateFundingHistory({ ...input, days }));
}
