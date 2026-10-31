/** Data-derived cadence estimates, not independently documented historical rules. */
import type { FundingHistoryLeg, FundingRuleSegment, SettledFundingEvent } from './history';

const HOUR = 3_600_000;
const PERIODS = new Set([1, 2, 3, 4, 6, 8, 12, 24]);
const CONFIRMATIONS = 3;

export function inferSettlementHour(event: SettledFundingEvent): SettledFundingEvent {
  const skew = event.settledAt % HOUR;
  if (event.kind !== 'regular' || !Number.isSafeInteger(event.settledAt) || skew <= 0 || skew > 999) return event;
  return { ...event, rawTime: event.rawTime ?? event.settledAt, settledAt: event.settledAt - skew,
    timeMappingEvidence: [event.timeMappingEvidence, 'inferred-hour-boundary-v1;processing-skew<=999ms'].filter(Boolean).join(';') };
}

/**
 * Three consecutive equal gaps establish a regime. Isolated larger gaps keep
 * the surrounding regime, so missing settlements remain missing. Systematic
 * omissions can resemble a sustained change; the result is labelled inferred.
 * All returned rates, pagination and conflict checks remain independent.
 */
export function inferFundingCadence(input: FundingHistoryLeg): FundingHistoryLeg {
  const leg = { ...input, events: input.events.map(inferSettlementHour) };
  const times = [...new Set(leg.events.filter((event) => event.kind === 'regular' && event.status === 'settled'
    && Number.isSafeInteger(event.settledAt) && event.settledAt > leg.pages.rangeStart && event.settledAt <= leg.pages.rangeEnd)
    .map((event) => event.settledAt))].sort((a, b) => a - b);
  const regimes: Array<{ index: number; hours: number; count: number }> = [];
  for (let i = 0; i + 1 < times.length;) {
    const hours = (times[i + 1]! - times[i]!) / HOUR;
    let end = i + 1;
    while (end + 1 < times.length && times[end + 1]! - times[end]! === hours * HOUR) end += 1;
    if (PERIODS.has(hours) && end - i >= CONFIRMATIONS && regimes.at(-1)?.hours !== hours) {
      regimes.push({ index: i, hours, count: end - i });
    }
    i = end;
  }
  if (!regimes.length || leg.pages.rangeEnd < leg.pages.rangeStart) {
    return { ...leg, cadence: { basis: leg.rules.length ? 'provided' : 'unavailable',
      intervals: [...new Set(leg.rules.map((rule) => rule.everyHours))], samples: times.length } };
  }
  const rules: FundingRuleSegment[] = regimes.map((regime, i) => ({
    from: i === 0 ? leg.pages.rangeStart : times[regime.index]! + 1,
    until: i + 1 < regimes.length ? times[regimes[i + 1]!.index]! + 1 : leg.pages.rangeEnd + 1,
    everyHours: regime.hours, anchor: times[regime.index]!,
    evidence: `settled-times-inference-v1;${leg.venue}/${leg.contractId};anchor=${times[regime.index]};equal-gaps=${regime.count};source=${leg.source.api}`,
  }));
  const ruleAt = (time: number) => rules.find((rule) => rule.from <= time && time < rule.until);
  return {
    ...leg, rules,
    cadence: { basis: 'inferred', intervals: [...new Set(regimes.map((regime) => regime.hours))], samples: times.length },
    // Existence at the first inferred period's start is an estimate, not a launch date.
    listing: leg.listing ?? { at: times[0]! - regimes[0]!.hours * HOUR, kind: 'inferred',
      evidence: `${rules[0]!.evidence};estimated-first-period-start` },
    events: leg.events.map((event) => {
      if (event.kind !== 'regular') return event;
      const inferred = ruleAt(event.settledAt);
      const provided = leg.rules.find((rule) => rule.from <= event.settledAt && event.settledAt < rule.until);
      // The collector fills intervalHours from the provided rule. Replace that
      // derived value, but retain independent contradictory interval evidence.
      return inferred && (event.intervalHours === null || event.intervalHours === provided?.everyHours)
        ? { ...event, intervalHours: inferred.everyHours } : event;
    }),
  };
}
