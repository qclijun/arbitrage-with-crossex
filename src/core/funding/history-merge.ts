import { historyReads, coversHistoryWindow, compareHistoryEvidence, type CachedHistoryLeg, type HistoryAttemptReason, type HistoryWindowEvidence } from './history-cache';
import { HISTORY_DAYS, type FundingHistoryLeg, type SettledFundingEvent } from './history';

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

/** Keep one newest whole read per window, including older cutoffs during a rolling backfill. */
export function retainHistoryLeg(prior: CachedHistoryLeg | undefined, fresh: FundingHistoryLeg, cutoff: number,
  at: number, reason: HistoryAttemptReason | null, maximumCutoff = cutoff): CachedHistoryLeg {
  const lastAttempt: FundingHistoryLeg['lastAttempt'] = reason ? { at, outcome: 'error', reason } : { at, outcome: 'success' };
  let reads = prior ? historyReads(prior).filter((read) => read.cutoff <= maximumCutoff) : [];
  const distinct = (events: SettledFundingEvent[]) => [...new Map(events.map((event) =>
    [JSON.stringify([event.settledAt, event.kind, event.status, event.rate, event.intervalHours]), event])).values()];
  if (fresh.source.reason === 'historical-policy-changed') reads = reads.map((read) => ({ ...read, leg: { ...read.leg,
    rules: read.leg.cadence?.basis === 'inferred' ? read.leg.rules : [],
    source: { ...read.leg.source, reason: 'historical-policy-changed' } } }));
  const intervals = (old: FundingHistoryLeg) => old.cadence?.basis !== 'inferred' && fresh.cadence?.basis !== 'inferred';
  const leg = { ...fresh, lastAttempt, events: distinct([...fresh.events,
    ...reads.flatMap((read) => revised(read.leg.events, fresh.events, intervals(read.leg)))]) };
  reads = reads.map((read) => ({ ...read, leg: { ...read.leg, lastAttempt,
    events: distinct([...read.leg.events, ...revised(leg.events, read.leg.events, intervals(read.leg))]) } }));
  if (fresh.verifiedAt !== null) reads.push({ cutoff, leg });
  if (!reads.length) return { cutoff, leg };
  reads.sort(compareHistoryEvidence);
  const latest = reads[0]!;
  const selected = new Set<HistoryWindowEvidence>();
  for (const days of HISTORY_DAYS) {
    const read = reads.find((read) => coversHistoryWindow(read, days));
    if (read) selected.add(read);
  }
  const wider = [...selected].filter((read) => read !== latest && read.cutoff === latest.cutoff)
    .sort((a, b) => a.leg.pages.rangeStart - b.leg.pages.rangeStart)[0];
  return { cutoff: latest.cutoff, leg: latest.leg, ...(wider ? { wider: wider.leg } : {}),
    retained: [...selected].filter((read) => read !== latest && read !== wider) };
}
