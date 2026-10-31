import type { CachedHistoryLeg, HistoryAttemptReason } from './history-cache';
import type { FundingHistoryLeg, SettledFundingEvent } from './history';

/**
 * Earlier reads of settlements the new read returned differently. Revision rules
 * are unproven (07), so the evaluator sees both variants and holds them as a
 * conflict instead of the new read silently overwriting the old one.
 */
function revised(prior: SettledFundingEvent[], fresh: SettledFundingEvent[], compareIntervals = true): SettledFundingEvent[] {
  const read = new Map<string, SettledFundingEvent[]>();
  for (const event of fresh) read.set(`${event.settledAt}:${event.kind}`, [...(read.get(`${event.settledAt}:${event.kind}`) ?? []), event]);
  return prior.filter((old) => read.get(`${old.settledAt}:${old.kind}`)
    ?.every((now) => now.rate !== old.rate || (compareIntervals && now.intervalHours !== null && old.intervalHours !== null
      && now.intervalHours !== old.intervalHours)));
}

/**
 * Always adopt a verified read: it is the freshest proof of the windows it covers.
 * An older read at the same cutoff that reaches further back stays as `wider`, so
 * the long windows keep their evidence (and its original verification time).
 * Legs from an older cutoff are dropped, never spliced into the new one.
 */
export function mergeHistoryLeg(prior: CachedHistoryLeg | undefined, fresh: FundingHistoryLeg, cutoff: number,
  at: number, reason: HistoryAttemptReason | null): CachedHistoryLeg {
  if (prior && fresh.source.reason === 'historical-policy-changed') {
    const reject = (leg: FundingHistoryLeg): FundingHistoryLeg => ({ ...leg, rules: leg.cadence?.basis === 'inferred' ? leg.rules : [],
      source: { ...leg.source, reason: 'historical-policy-changed' } });
    prior = { ...prior, leg: reject(prior.leg), ...(prior.wider ? { wider: reject(prior.wider) } : {}) };
  }
  const lastAttempt: FundingHistoryLeg['lastAttempt'] = reason ? { at, outcome: 'error', reason } : { at, outcome: 'success' };
  const priorWidest = prior?.cutoff === cutoff ? prior.wider ?? prior.leg : undefined;
  if (fresh.verifiedAt !== null) {
    const compareIntervals = fresh.cadence?.basis !== 'inferred' && prior?.leg.cadence?.basis !== 'inferred';
    const leg = { ...fresh, events: [...fresh.events, ...revised(prior?.leg.events ?? [], fresh.events, compareIntervals)], lastAttempt };
    if (!priorWidest || priorWidest.verifiedAt === null || fresh.pages.rangeStart <= priorWidest.pages.rangeStart) {
      return { cutoff, leg };
    }
    return { cutoff, leg, wider: { ...priorWidest, events: [...priorWidest.events, ...revised(fresh.events, priorWidest.events, compareIntervals)],
      lastAttempt } };
  }
  if (prior) {
    return { cutoff: prior.cutoff, leg: { ...prior.leg, lastAttempt },
      ...(prior.wider ? { wider: { ...prior.wider, lastAttempt } } : {}) };
  }
  return { cutoff, leg: { ...fresh, lastAttempt } };
}
