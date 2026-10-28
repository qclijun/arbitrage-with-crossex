/**
 * The engine books slice fills itself (ticket 15): every tick ends by booking
 * what it observed, database only — the tick's single wire mutation budget is
 * untouched, and a restart books nothing twice.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { tickPair, type LoopDeps } from '../../src/engine/loop';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from './engine-sim';
import { deal } from '../helpers/slice-fixture';

describe('engine slice booking', () => {
  it('books a maker fill and its hedge into the named slice as the loop converges', async () => {
    const store = new Store(':memory:');
    const venue = new FakeVenue();
    const clock = new VirtualClock();
    const deps: LoopDeps = { store, venue, clock };
    store.slices.create({
      id: 'X', kind: 'funding-two-leg', source: {}, now: 1, observed: { [A_CONTRACT]: '0', [B_CONTRACT]: '0' },
      legs: [{ leg: 'long', contract: A_CONTRACT, side: 'long' }, { leg: 'short', contract: B_CONTRACT, side: 'short' }],
    });
    deal(store, 'open-x', { contract: A_CONTRACT, side: 'BUY' }, { contract: B_CONTRACT, side: 'SELL' }, '0.152');
    store.slices.attach('open-x', 'X', 'open');

    await tickPair(deps, 'open-x'); // places the maker
    const maker = venue.liveOrder(A_CONTRACT)!;
    venue.fill(maker.clientText, '0.1');
    const before = venue.createCalls.length;
    await tickPair(deps, 'open-x'); // observes 0.1, hedges
    expect(venue.createCalls.length - before).toBeLessThanOrEqual(1);
    expect(store.slices.get('X')!.legs.find((l) => l.leg === 'long')!.qty).toBe('0.1');

    venue.fill(maker.clientText, '0.052');
    for (let i = 0; i < 8; i++) {
      await tickPair(deps, 'open-x');
      clock.advance(1000);
    }
    expect(store.getPair('open-x')!.mode).toBe('DONE');
    expect(Object.fromEntries(store.slices.get('X')!.legs.map((l) => [l.leg, l.qty]))).toEqual({ long: '0.152', short: '0.152' });
    expect(store.slices.book(A_CONTRACT)!.explained).toBe('0.152');
    expect(store.slices.book(B_CONTRACT)!.explained).toBe('-0.152');

    // A later tick of the finished deal (a restart) books nothing again.
    await tickPair(deps, 'open-x');
    expect(store.slices.movements('X').filter((m) => m.kind === 'fill')).toHaveLength(store.slices.movements('X').length);
    expect(store.slices.get('X')!.legs.find((l) => l.leg === 'long')!.qty).toBe('0.152');
  });

  it('moves the explained book for an unattached deal on a tracked contract, leaving slices alone', async () => {
    const store = new Store(':memory:');
    const venue = new FakeVenue();
    const deps: LoopDeps = { store, venue, clock: new VirtualClock() };
    store.slices.create({
      id: 'X', kind: 'boros-hedge', source: {}, now: 1, observed: { [A_CONTRACT]: '1' },
      legs: [{ leg: 'perp', contract: A_CONTRACT, side: 'long' }],
    });
    deal(store, 'other', { contract: A_CONTRACT, side: 'BUY' }, null, '0.2', {});
    store.updatePair('other', { mode: 'CONVERTING' });
    for (let i = 0; i < 4; i++) await tickPair(deps, 'other');
    expect(store.slices.book(A_CONTRACT)!.explained).toBe('1.2');
    expect(store.slices.get('X')!.legs[0].qty).toBe('0');
  });
});
