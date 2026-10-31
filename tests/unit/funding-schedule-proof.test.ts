import { describe, expect, it } from 'vitest';
import { acceptCurrentInterval, inProvenRange, proveSettlementRun, type RunInput } from '../../src/core/funding/schedule-proof';

const H = 3_600_000;
const D = 24 * H;
/** 2026-10-01 10:00 UTC: the newest 8-hour settlement before it is 08:00. */
const CUTOFF = Date.UTC(2026, 9, 1, 10);
const RANGE = CUTOFF - 7 * D;
const every = (hours: number, from: number, to: number) => {
  const out: number[] = [];
  for (let t = Math.ceil(from / (hours * H)) * hours * H; t <= to; t += hours * H) out.push(t);
  return out;
};
const eightHourly = every(8, RANGE + 1, CUTOFF);
const prove = (regularSettledAt: number[], everyHours = 8, rangeStart = RANGE): ReturnType<typeof proveSettlementRun> =>
  proveSettlementRun({ everyHours, currentAt: CUTOFF, rangeStart, cutoff: CUTOFF, regularSettledAt } satisfies RunInput);

describe('acceptCurrentInterval', () => {
  const now = CUTOFF + 60_000;
  it.each([
    ['no quote', undefined, { ok: false, reason: 'no-current-interval' }],
    ['a quote older than 15 minutes', { intervalHours: 8, at: now - 15 * 60_000 - 1 }, { ok: false, reason: 'current-interval-stale' }],
    ['a quote dated in the future', { intervalHours: 8, at: now + 1 }, { ok: false, reason: 'current-interval-stale' }],
    ['an interval that does not divide a day', { intervalHours: 5, at: now }, { ok: false, reason: 'current-interval-unusable' }],
    ['a zero interval', { intervalHours: 0, at: now }, { ok: false, reason: 'current-interval-unusable' }],
    ['a fractional interval', { intervalHours: 0.5, at: now }, { ok: false, reason: 'current-interval-unusable' }],
    ['a fresh 8-hour quote', { intervalHours: 8, at: now - 15 * 60_000 }, { ok: true, everyHours: 8, observedAt: now - 15 * 60_000 }],
    ['a fresh hourly quote', { intervalHours: 1, at: now }, { ok: true, everyHours: 1, observedAt: now }],
  ] as const)('%s', (_name, current, expected) => {
    expect(acceptCurrentInterval(current, now)).toEqual(expected);
  });
});

describe('proveSettlementRun', () => {
  const newest = CUTOFF - 2 * H;
  const first = eightHourly[0]!;

  it('claims the read range when the regular run reaches its edge', () => {
    const proof = prove(eightHourly);
    expect(proof).toMatchObject({ ok: true, rule: { from: RANGE, until: newest + 8 * H, everyHours: 8, anchor: newest } });
    expect(proof.ok && proof.rule.evidence).toMatch(/21 settled records every 8h .*current official interval 8h/);
  });

  it.each([
    ['a head void longer than one interval', eightHourly.slice(3), eightHourly[3]],
    ['an off-grid record before the run', [first - 3 * H, ...eightHourly], first],
    ['a missing record inside the range', eightHourly.filter((t) => t !== eightHourly[10]), eightHourly[11]],
    ['an extra off-grid record inside the run', [...eightHourly, eightHourly[15]! + H], eightHourly[16]],
  ])('starts the run after %s', (_name, times, from) => {
    expect(prove(times as number[])).toMatchObject({ ok: true, rule: { from, until: newest + 8 * H, anchor: newest } });
  });

  it.each([
    ['nothing was read', [], 'no-settlements'],
    ['records sit only outside the read range', [RANGE, CUTOFF + 6 * H], 'no-settlements'],
    ['the newest settlement has not posted', eightHourly.slice(0, -1), 'newest-settlement-missing'],
    ['the newest record is off the grid', [...eightHourly.slice(0, -1), newest + 1], 'newest-off-grid'],
    ['a regular run sits one second off the grid', eightHourly.map((t) => t + 1_000), 'newest-off-grid'],
    ['one record stands alone after a gap', [...eightHourly.slice(0, -2), newest], 'run-too-short'],
  ])('refuses when %s', (_name, times, reason) => {
    expect(prove(times as number[])).toEqual({ ok: false, reason });
  });

  it('proves only the trailing run of an 8h to 4h change, and only under the current interval', () => {
    const switchAt = CUTOFF - 2 * D - 2 * H;
    const history = [...every(8, RANGE + 1, switchAt - 1), ...every(4, switchAt, CUTOFF)];
    expect(prove(history, 4)).toMatchObject({ ok: true, rule: { from: switchAt, everyHours: 4, anchor: CUTOFF - 2 * H } });
    expect(prove(history, 8)).toEqual({ ok: false, reason: 'run-too-short' });
    // The interval changed before its first new-cadence settlement: one record shows no cadence.
    expect(prove([...every(8, RANGE + 1, CUTOFF - 7 * H), CUTOFF - 2 * H], 4)).toEqual({ ok: false, reason: 'run-too-short' });
  });

  it('ignores duplicates and order', () => {
    expect(prove([...eightHourly].reverse().concat(eightHourly))).toEqual(prove(eightHourly));
  });

  it('vouches only for events inside the proven run', () => {
    const proof = prove(eightHourly.slice(3));
    if (!proof.ok) throw new Error('expected a proof');
    const events = eightHourly.map((settledAt) => ({ settledAt }));
    expect(inProvenRange(events, proof.rule)).toEqual(events.slice(3));
  });
});
