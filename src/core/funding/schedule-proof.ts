/**
 * Which settlement times the history evaluator may expect for one leg. The
 * approved "double proof" (2026-10-31): a cadence holds only over settled
 * records that are exactly regular on the UTC grid AND whose interval equals
 * the venue's current official interval. Pure: no IO, no clock.
 */
import { FRESH_MS, type FundingRuleSegment } from './history';

const HOUR = 3_600_000;

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

const dividesDay = (hours: number) => Number.isInteger(hours) && hours > 0 && 24 % hours === 0;

export function acceptCurrentInterval(current: CurrentSchedule | undefined, now: number): CurrentInterval {
  if (!current) return { ok: false, reason: 'no-current-interval' };
  if (current.at > now || now - current.at > FRESH_MS) return { ok: false, reason: 'current-interval-stale' };
  const hours = current.intervalHours;
  if (!dividesDay(hours)) return { ok: false, reason: 'current-interval-unusable' };
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
 * The trailing run of records spaced exactly one current interval
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
  if (runLength < 2) return { ok: false, reason: 'run-too-short' };
  const noGridPointBeforeFirst = i === 0 && first - period <= input.rangeStart;
  const from = noGridPointBeforeFirst ? input.rangeStart : first;
  return { ok: true, rule: { from, until: last + period, everyHours: input.everyHours, anchor: last,
    evidence: `double proof: ${runLength} settled records every ${input.everyHours}h on the UTC grid ${iso(first)}..${iso(last)}`
      + `; current official interval ${input.everyHours}h read ${iso(input.currentAt)}` } };
}

/** Events the proof vouches for; records before the run are dropped, never re-stamped. */
export function inProvenRange<T extends { settledAt: number }>(events: readonly T[], rule: FundingRuleSegment): T[] {
  return events.filter((e) => e.settledAt >= rule.from && e.settledAt < rule.until);
}
