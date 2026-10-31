import { expect, it } from 'vitest';
import { inferFundingCadence } from '../../src/core/funding/cadence-inference';
import { evaluateFundingLeg } from '../../src/core/funding/history';
import { CUTOFF, D, H, NOW, flat, historyLeg } from '../helpers/funding-ranking-fixture';

function raw() {
  const leg = historyLeg('BINANCE', 'BTCUSDT', flat('0.0001'));
  leg.rules = [];
  leg.events = leg.events.map((event) => ({ ...event, intervalHours: null }));
  return leg;
}

it('infers a stable eight-hour cadence and existence from settled records for every window', () => {
  const leg = raw(); leg.listing = null;
  const inferred = inferFundingCadence(leg);
  expect(inferred.cadence).toMatchObject({ basis: 'inferred', intervals: [8] });
  expect(inferred.listing?.kind).toBe('inferred');
  for (const days of [7, 30, 90, 180, 365] as const) {
    expect(evaluateFundingLeg(inferred, CUTOFF, days, NOW)).toMatchObject({ coverage: 'complete', fresh: true,
      cadence: { basis: 'inferred', intervals: [8] }, observed: { events: days * 3 } });
  }
  expect(leg.rules).toEqual([]);
  expect(leg.events[0]!.intervalHours).toBeNull();
});

it.each([CUTOFF - 8 * H, CUTOFF - 365 * D + 8 * H, CUTOFF])('detects a missing settlement at %s without interpreting one gap as a new cadence', (drop) => {
  const leg = raw(); leg.events = leg.events.filter((event) => event.settledAt !== drop);
  const inferred = inferFundingCadence(leg);
  expect(inferred.rules).toHaveLength(1);
  expect(evaluateFundingLeg(inferred, CUTOFF, 365, NOW)).toMatchObject({ coverage: 'partial', total: null, missingEvents: [drop],
    observed: { events: 1094 } });
});

it('models a sustained 8h to 4h change as contiguous segments, preserving the transition settlement', () => {
  const leg = raw();
  const pivot = CUTOFF - 3 * D;
  leg.events = leg.events.filter((event) => event.settledAt <= pivot);
  for (let time = pivot + 4 * H; time <= CUTOFF; time += 4 * H) {
    leg.events.push({ settledAt: time, rate: '0.0001', intervalHours: null, status: 'settled', kind: 'regular', evidence: `fixture:${time}` });
  }
  const inferred = inferFundingCadence(leg);
  expect(inferred.cadence?.intervals).toEqual([8, 4]);
  expect(inferred.rules[0]!.until).toBe(inferred.rules[1]!.from);
  expect(evaluateFundingLeg(inferred, CUTOFF, 7, NOW)).toMatchObject({ coverage: 'complete', missingEvents: [], observed: { events: 30 } });
});

it('does not promote a short irregular tail into a confirmed cadence change', () => {
  const leg = raw();
  leg.events = leg.events.filter((event) => event.settledAt < CUTOFF);
  for (const time of [CUTOFF - 4 * H, CUTOFF]) leg.events.push({ ...leg.events.at(-1)!, settledAt: time });
  expect(evaluateFundingLeg(inferFundingCadence(leg), CUTOFF, 7, NOW).coverage).toBe('unknown');
});

it.each(['conflict', 'pagination', 'recent-listing', 'insufficient-samples'] as const)('does not let inference bypass %s', (failure) => {
  const leg = raw();
  if (failure === 'conflict') leg.events.push({ ...leg.events.at(-1)!, rate: '0.99' });
  if (failure === 'pagination') leg.pages.complete = false;
  if (failure === 'recent-listing') leg.listing = { at: CUTOFF - 3 * D, evidence: 'fixture listing', kind: 'listed-at' };
  if (failure === 'insufficient-samples') leg.events = leg.events.slice(-3);
  expect(evaluateFundingLeg(inferFundingCadence(leg), CUTOFF, 7, NOW).coverage).not.toBe('complete');
});

it('uses data inference when old document approval is withdrawn, retaining its provenance', () => {
  const leg = raw(); leg.source.reason = 'historical-policy-changed';
  expect(evaluateFundingLeg(inferFundingCadence(leg), CUTOFF, 7, NOW)).toMatchObject({ coverage: 'complete',
    source: { reason: 'historical-policy-changed' }, cadence: { basis: 'inferred' } });
});

it('preserves raw times while estimating subsecond processing jitter at an hour boundary', () => {
  const leg = raw();
  leg.events = leg.events.map((event, i) => ({ ...event, settledAt: event.settledAt + i % 4 }));
  const inferred = inferFundingCadence(leg);
  expect(inferred.events[1]).toMatchObject({ settledAt: leg.events[1]!.settledAt - 1,
    rawTime: leg.events[1]!.settledAt, timeMappingEvidence: expect.stringContaining('inferred-hour-boundary') });
  expect(evaluateFundingLeg(inferred, CUTOFF, 7, NOW)).toMatchObject({ coverage: 'complete', missingEvents: [] });
});

it('does not snap a larger irregular time shift to the hour', () => {
  const leg = raw(); leg.events.at(-2)!.settledAt += 1_500;
  expect(evaluateFundingLeg(inferFundingCadence(leg), CUTOFF, 7, NOW).coverage).toBe('unknown');
});
