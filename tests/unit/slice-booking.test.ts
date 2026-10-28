/**
 * Strategy slices book ACTUAL per-leg fills (ticket 15): each deal leg's
 * cumulative fill is booked once, by delta, to the one slice the deal names.
 * Targets and hedge reservations are never holdings, a reduce never touches
 * another slice, and nothing is guessed when evidence shrinks or overshoots.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { SliceRefusal } from '../../src/engine/slices';
import { deal, LONG_C, order, OTHER_C, setCum, SHORT_C, twoLegSlice } from '../helpers/slice-fixture';

const legsOf = (store: Store, id: string) =>
  Object.fromEntries(store.slices.get(id)!.legs.map((l) => [l.leg, l.qty]));

/** Open `qty` into a slice through a filled two-leg deal. */
function openInto(store: Store, sliceId: string, dealId: string, qty: string, action: 'open' | 'add' = 'open'): void {
  deal(store, dealId, { contract: LONG_C, side: 'BUY' }, { contract: SHORT_C, side: 'SELL' }, qty);
  store.slices.attach(dealId, sliceId, action);
  order(store, dealId, 'A', qty, qty);
  order(store, dealId, 'B', qty, qty);
  store.slices.bookFills(dealId, 20);
  store.updatePair(dealId, { mode: 'DONE' });
}

function refusalOf(fn: () => unknown): SliceRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof SliceRefusal) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('booking actual fills', () => {
  it('books each leg by its own actual fill — the hedge reservation is not a holding', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    deal(store, 'open-x', { contract: LONG_C, side: 'BUY' }, { contract: SHORT_C, side: 'SELL' }, '1');
    store.slices.attach('open-x', 'X', 'open');
    order(store, 'open-x', 'A', '1', '0.4', 'OPEN');
    order(store, 'open-x', 'B', '0.4', '0.1', 'OPEN'); // 0.4 reserved, 0.1 filled
    store.slices.bookFills('open-x', 20);
    expect(legsOf(store, 'X')).toEqual({ long: '0.4', short: '0.1' });
  });

  it('books a repeated or late observation once, by delta only', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    deal(store, 'open-x', { contract: LONG_C, side: 'BUY' }, { contract: SHORT_C, side: 'SELL' }, '1');
    store.slices.attach('open-x', 'X', 'open');
    const seq = order(store, 'open-x', 'A', '1', '0.3', 'OPEN');
    store.slices.bookFills('open-x', 20);
    store.slices.bookFills('open-x', 21); // same evidence again (a restart, a re-tick)
    expect(legsOf(store, 'X').long).toBe('0.3');
    setCum(store, 'open-x', 'A', seq, '0.7');
    store.slices.bookFills('open-x', 22);
    expect(legsOf(store, 'X').long).toBe('0.7');
    expect(store.slices.movements('X').filter((m) => m.kind === 'fill').map((m) => m.delta)).toEqual(['0.3', '0.4']);
  });

  it('refuses to unbook a shrinking fill: it alerts and leaves the slice alone', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    deal(store, 'open-x', { contract: LONG_C, side: 'BUY' }, null, '1');
    store.slices.attach('open-x', 'X', 'open');
    const seq = order(store, 'open-x', 'A', '1', '0.5', 'OPEN');
    store.slices.bookFills('open-x', 20);
    setCum(store, 'open-x', 'A', seq, '0.2');
    store.slices.bookFills('open-x', 21);
    expect(legsOf(store, 'X').long).toBe('0.5');
    expect(store.listAlerts().map((a) => a.message).join()).toMatch(/shrank/);
  });

  it('reduces only the slice named, never its same-direction neighbor', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    twoLegSlice(store, 'Y');
    openInto(store, 'X', 'open-x', '1');
    openInto(store, 'Y', 'open-y', '1');
    deal(store, 'cut-x', { contract: LONG_C, side: 'SELL', reduceOnly: true }, { contract: SHORT_C, side: 'BUY', reduceOnly: true }, '0.5');
    store.slices.attach('cut-x', 'X', 'reduce');
    order(store, 'cut-x', 'A', '0.5', '0.5');
    order(store, 'cut-x', 'B', '0.5', '0.5');
    store.slices.bookFills('cut-x', 30);
    expect(legsOf(store, 'X')).toEqual({ long: '0.5', short: '0.5' });
    expect(legsOf(store, 'Y')).toEqual({ long: '1', short: '1' });
  });

  it('keeps a partial close and its dust as the actual remainder', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    openInto(store, 'X', 'open-x', '1');
    deal(store, 'cut-x', { contract: LONG_C, side: 'SELL', reduceOnly: true }, { contract: SHORT_C, side: 'BUY', reduceOnly: true }, '1', { mode: 'DONE' });
    store.slices.attach('cut-x', 'X', 'reduce');
    order(store, 'cut-x', 'A', '1', '0.703');
    order(store, 'cut-x', 'B', '0.7', '0.7');
    store.slices.bookFills('cut-x', 30);
    expect(legsOf(store, 'X')).toEqual({ long: '0.297', short: '0.3' });
  });

  it('books a reduce beyond the slice to zero, records the excess as unattributed and flags the contract', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    openInto(store, 'X', 'open-x', '0.5');
    deal(store, 'cut-x', { contract: LONG_C, side: 'SELL', reduceOnly: true }, null, '0.5');
    store.slices.attach('cut-x', 'X', 'reduce');
    order(store, 'cut-x', 'A', '0.8', '0.8'); // the venue filled more than the slice held
    store.slices.bookFills('cut-x', 30);
    expect(legsOf(store, 'X').long).toBe('0');
    expect(store.slices.movements('X').at(-1)).toMatchObject({ kind: 'fill', delta: '-0.5' });
    expect(store.slices.movements(null).map((m) => [m.kind, m.contract, m.delta])).toEqual([['excess', LONG_C, '-0.3']]);
    expect(store.slices.book(LONG_C)).toMatchObject({ flag: expect.stringMatching(/exceeded/) });
    expect(store.listAlerts().some((a) => /exceeded/.test(a.message))).toBe(true);
  });
});

describe('attaching deals to slices', () => {
  it('refuses a deal whose legs are not the slice legs in the slice direction', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    deal(store, 'wrong-side', { contract: LONG_C, side: 'SELL' }, { contract: SHORT_C, side: 'BUY' }, '1');
    expect(refusalOf(() => store.slices.attach('wrong-side', 'X', 'open')).code).toBe('leg-mismatch');
    deal(store, 'other-contract', { contract: OTHER_C, side: 'BUY' }, null, '1');
    expect(refusalOf(() => store.slices.attach('other-contract', 'X', 'add')).code).toBe('leg-mismatch');
    deal(store, 'open-as-reduce', { contract: LONG_C, side: 'SELL' }, null, '1');
    expect(refusalOf(() => store.slices.attach('open-as-reduce', 'X', 'reduce')).code).toBe('leg-mismatch'); // not reduce-only
    expect(refusalOf(() => store.slices.attach('missing', 'X', 'open')).code).toBe('unknown-deal');
  });

  it('reserves an active reduce against the slice, so a second reduce cannot take the same share', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    openInto(store, 'X', 'open-x', '1');
    deal(store, 'cut-1', { contract: LONG_C, side: 'SELL', reduceOnly: true }, null, '0.7');
    store.slices.attach('cut-1', 'X', 'reduce');
    order(store, 'cut-1', 'A', '0.7', '0.2', 'OPEN');
    store.slices.bookFills('cut-1', 30);
    expect(store.slices.reducible('X')).toMatchObject({ long: { qty: '0.8', reserved: '0.5', reducible: '0.3' } });
  });

  it('refuses a slice on a contract an unfinished deal is still working', () => {
    const store = new Store(':memory:');
    deal(store, 'busy', { contract: LONG_C, side: 'BUY' }, null, '1');
    expect(refusalOf(() => twoLegSlice(store, 'X')).code).toBe('contract-in-flight');
    expect(store.slices.get('X')).toBeNull();
  });

  it('refuses a slice opposite to a held slice on the same contract — no fictitious inner hedge', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    openInto(store, 'X', 'open-x', '1');
    expect(refusalOf(() => store.slices.create({
      id: 'Z', kind: 'funding-two-leg', source: {}, now: 11, observed: {},
      legs: [{ leg: 'short', contract: LONG_C, side: 'short' }, { leg: 'long', contract: SHORT_C, side: 'long' }],
    })).code).toBe('opposite-slice');
  });
});
