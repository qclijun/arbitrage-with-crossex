import { expect, it } from 'vitest';
import { evaluateFundingLeg } from '../../src/core/funding/history';
import { CUTOFF, NOW, flat, historyLeg, M } from '../helpers/funding-ranking-fixture';

function unverified() {
  const leg = historyLeg('ASTER', 'BTCUSDT', flat('0.0001'));
  leg.rules = []; leg.listing = null;
  leg.events.forEach((event) => { event.intervalHours = null; });
  return leg;
}

it('keeps observational totals separate from completeness and treats cadence proof as an upgrade', () => {
  const leg = unverified();
  leg.events.push({ ...leg.events.at(-1)!, intervalHours: 8 });
  const result = evaluateFundingLeg(leg, CUTOFF, 365, NOW);
  expect(result).toMatchObject({ coverage: 'unknown', total: null, annualized: null, conflicts: [],
    observed: { total: '0.1095', annualized: '0.1095', events: 1095 } });
});

it.each(['conflict', 'invalid', 'pagination', 'source', 'empty'] as const)('does not publish observations from %s evidence', (failure) => {
  const leg = unverified();
  if (failure === 'conflict') leg.events.push({ ...leg.events.at(-1)!, rate: '0.99' });
  if (failure === 'invalid') leg.events.at(-1)!.rate = 'NaN';
  if (failure === 'pagination') leg.pages.complete = false;
  if (failure === 'source') leg.source.status = 'unknown';
  if (failure === 'empty') leg.events = [];
  expect(evaluateFundingLeg(leg, CUTOFF, 365, NOW).observed).toBeNull();
});

it('keeps old observations visibly stale and refuses a different cutoff', () => {
  const leg = unverified();
  expect(evaluateFundingLeg(leg, CUTOFF, 365, CUTOFF + 20 * M)).toMatchObject({ fresh: false, observed: { events: 1095 } });
  expect(evaluateFundingLeg(leg, CUTOFF + 3_600_000, 365, CUTOFF + 3_600_000 + M).observed).toBeNull();
});
