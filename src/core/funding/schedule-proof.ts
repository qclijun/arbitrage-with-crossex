/**
 * Which settlement times the history evaluator may expect for one leg. The
 * approved "double proof" (2026-10-31): a cadence holds only over settled
 * records that are exactly regular on the UTC grid AND whose interval equals
 * the venue's current official interval. Pure: no IO, no clock.
 */
import type { FundingRuleSegment } from './history';

const HOUR = 3_600_000;

/** The slice of a market quote the proof needs; `CurrentFundingRate` satisfies it. */
export interface CurrentSchedule {
  intervalHours: number;
  /** When the market poller read this interval. */
  at: number;
}

export type CurrentRefusal = 'no-current-interval' | 'current-interval-stale' | 'current-interval-unusable';
export type RunRefusal = 'no-settlements' | 'newest-settlement-missing' | 'newest-off-grid' | 'run-too-short';
/** Why a leg's cadence stays UNKNOWN; published as `schedule:<reason>` in the pages' termination. */
export type ScheduleRefusal = CurrentRefusal | RunRefusal;

export type CurrentInterval =
  | { ok: true; everyHours: number; observedAt: number }
  | { ok: false; reason: CurrentRefusal };

export type ScheduleProof =
  | { ok: true; rule: FundingRuleSegment }
  | { ok: false; reason: RunRefusal };

/** The evaluator's freshness bound: an older quote cannot speak for the interval now. */
export const CURRENT_MAX_AGE_MS = 15 * 60_000;

/** Proof 2, parsed before any page request so an unprovable leg spends no budget. */
export function acceptCurrentInterval(current: CurrentSchedule | undefined, now: number): CurrentInterval {
  if (!current) return { ok: false, reason: 'no-current-interval' };
  if (current.at > now || now - current.at > CURRENT_MAX_AGE_MS) return { ok: false, reason: 'current-interval-stale' };
  const hours = current.intervalHours;
  // Only a divisor of a day defines one UTC grid shared by every day.
  if (!Number.isInteger(hours) || hours <= 0 || 24 % hours !== 0) return { ok: false, reason: 'current-interval-unusable' };
  return { ok: true, everyHours: hours, observedAt: current.at };
}

export interface RunInput {
  everyHours: number;
  /** When the current interval was read; evidence text only. */
  currentAt: number;
  /** Pages are complete over (rangeStart, cutoff]. */
  rangeStart: number;
  cutoff: number;
  /** settledAt of every regular record read; any order, duplicates allowed. */
  regularSettledAt: readonly number[];
}

const iso = (at: number) => new Date(at).toISOString();

/**
 * Proof 1: the trailing run of records spaced exactly one current interval
 * apart and ending on the grid at the newest record. Any short or long gap ends
 * the run; a gap is never fitted, because a missing record and a slower cadence
 * look the same.
 */
export function proveSettlementRun(input: RunInput): ScheduleProof {
  const period = input.everyHours * HOUR;
  const times = [...new Set(input.regularSettledAt)]
    .filter((t) => t > input.rangeStart && t <= input.cutoff).sort((a, b) => a - b);
  const last = times.at(-1);
  if (last === undefined) return { ok: false, reason: 'no-settlements' };
  if (last + period <= input.cutoff) return { ok: false, reason: 'newest-settlement-missing' };
  if (last % period !== 0) return { ok: false, reason: 'newest-off-grid' };
  let i = times.length - 1;
  while (i > 0 && times[i]! - times[i - 1]! === period) i -= 1;
  const first = times[i]!;
  const runLength = times.length - i;
  // One record shows no spacing at all, e.g. the first settlement after an interval change.
  if (runLength < 2) return { ok: false, reason: 'run-too-short' };
  // Reach back to the read's edge only when no grid point can hide between it and `first`.
  const from = i === 0 && first - period <= input.rangeStart ? input.rangeStart : first;
  return { ok: true, rule: { from, until: last + period, everyHours: input.everyHours, anchor: last,
    evidence: `double proof: ${runLength} settled records every ${input.everyHours}h on the UTC grid ${iso(first)}..${iso(last)}`
      + `; current official interval ${input.everyHours}h read ${iso(input.currentAt)}` } };
}

/** Events the proof vouches for; records before the run are dropped, never re-stamped. */
export function inProvenRange<T extends { settledAt: number }>(events: readonly T[], rule: FundingRuleSegment): T[] {
  return events.filter((e) => e.settledAt >= rule.from && e.settledAt < rule.until);
}
