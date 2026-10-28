/**
 * Per-contract reconciliation of the slice ledger (ticket 15). Equal totals
 * are necessary, never sufficient: the ledger must also explain how the
 * position got there, attribution must fit inside the actual position, and
 * an unexplained change stays UNKNOWN until the user reconciles it.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { reconcileContract } from '../../src/engine/slice-reconcile';
import { SliceRefusal } from '../../src/engine/slices';
import { deal, LONG_C, order, OTHER_C, SHORT_C, twoLegSlice } from '../helpers/slice-fixture';

function openInto(store: Store, sliceId: string, dealId: string, qty: string): void {
  deal(store, dealId, { contract: LONG_C, side: 'BUY' }, { contract: SHORT_C, side: 'SELL' }, qty);
  store.slices.attach(dealId, sliceId, 'open');
  order(store, dealId, 'A', qty, qty);
  order(store, dealId, 'B', qty, qty);
  store.slices.bookFills(dealId, 20);
  store.updatePair(dealId, { mode: 'DONE' });
}

const rec = (store: Store, contract: string, actual: string | null) => reconcileContract(store.slices.contractState(contract), actual);

describe('reconcileContract', () => {
  it('reconciles when the position is exactly what the ledger explains, splitting attributed from unattributed', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X', { [LONG_C]: '0.25' }); // 0.25 already held, unattributed
    openInto(store, 'X', 'open-x', '1');
    expect(rec(store, LONG_C, '1.25')).toEqual({
      status: 'reconciled', actual: '1.25', explained: '1.25', attributed: '1', unattributed: '0.25',
    });
    expect(rec(store, SHORT_C, '-1')).toMatchObject({ status: 'reconciled', attributed: '-1', unattributed: '0' });
  });

  it('leaves a contract no slice touches untracked — all of it unattributed', () => {
    const store = new Store(':memory:');
    expect(rec(store, OTHER_C, '3')).toMatchObject({ status: 'untracked', attributed: '0', unattributed: '3' });
  });

  it('calls any change the ledger cannot explain external, in either direction', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    openInto(store, 'X', 'open-x', '1');
    expect(rec(store, LONG_C, '0.5')).toMatchObject({ status: 'external-change', explained: '1', actual: '0.5' });
    expect(rec(store, LONG_C, '1.2')).toMatchObject({ status: 'external-change', unattributed: '0.2' });
  });

  it('reports a contract with execution in flight as in flight, not as a discrepancy', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    deal(store, 'working', { contract: LONG_C, side: 'BUY' }, null, '1');
    expect(rec(store, LONG_C, '0.3')).toMatchObject({ status: 'in-flight' });
  });

  it('is UNKNOWN when the position could not be read', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    expect(rec(store, LONG_C, null)).toMatchObject({ status: 'unknown', actual: null });
  });

  it('flags attribution that does not fit inside the actual position', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    openInto(store, 'X', 'open-x', '1');
    // A ledger edited to agree with a smaller position: explained matches, attribution cannot.
    expect(reconcileContract({ ...store.slices.contractState(LONG_C), explained: '0.4' }, '0.4'))
      .toMatchObject({ status: 'over-attributed', attributed: '1' });
  });

  it('keeps a flagged contract UNKNOWN until it is explicitly reconciled', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    openInto(store, 'X', 'open-x', '0.5');
    deal(store, 'cut', { contract: LONG_C, side: 'SELL', reduceOnly: true }, null, '0.5', { mode: 'DONE' });
    store.slices.attach('cut', 'X', 'reduce');
    order(store, 'cut', 'A', '0.8', '0.8');
    store.slices.bookFills('cut', 30);
    expect(rec(store, LONG_C, '-0.3')).toMatchObject({ status: 'needs-recovery' });
  });

  it('splits 4.03 into the 0.36 a strategy proved and 3.67 left unattributed', () => {
    const store = new Store(':memory:');
    store.slices.create({
      id: 'boros-gate', kind: 'boros-hedge', source: { route: 'singles', marketIds: [198] }, now: 10,
      legs: [{ leg: 'perp', contract: LONG_C, side: 'long' }], observed: { [LONG_C]: '4.03' },
    });
    store.slices.claim({ sliceId: 'boros-gate', leg: 'perp', qty: '0.36', observedActual: '4.03', evidence: 'Gate single 0.36', now: 11 });
    expect(rec(store, LONG_C, '4.03')).toMatchObject({ status: 'reconciled', attributed: '0.36', unattributed: '3.67' });
    expect(store.slices.movements('boros-gate')).toEqual([
      expect.objectContaining({ kind: 'claim', delta: '0.36', observedAt: 11, evidence: 'Gate single 0.36' }),
    ]);
  });

  it('never claims more than is unattributed, or against a position it cannot explain', () => {
    const store = new Store(':memory:');
    store.slices.create({
      id: 'S', kind: 'boros-hedge', source: {}, now: 10, legs: [{ leg: 'perp', contract: LONG_C, side: 'long' }], observed: { [LONG_C]: '1' },
    });
    const claim = (qty: string, observedActual: string) => () =>
      store.slices.claim({ sliceId: 'S', leg: 'perp', qty, observedActual, evidence: 'x', now: 11 });
    expect(claim('1.5', '1')).toThrow(SliceRefusal);
    expect(claim('0.5', '0.8')).toThrow(/explain/);
    expect(store.slices.get('S')!.legs[0].qty).toBe('0');
  });
});

describe('explicit recovery', () => {
  it('re-baselines on the observed position with the user-stated per-slice adjustments', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    twoLegSlice(store, 'Y');
    openInto(store, 'X', 'open-x', '1');
    openInto(store, 'Y', 'open-y', '1');
    expect(rec(store, LONG_C, '1.5')).toMatchObject({ status: 'external-change' });
    store.slices.recover({
      contract: LONG_C, observedActual: '1.5', evidence: 'closed 0.5 of X by hand on the venue', now: 40,
      adjustments: [{ sliceId: 'X', leg: 'long', delta: '-0.5' }],
    });
    expect(rec(store, LONG_C, '1.5')).toMatchObject({ status: 'reconciled', attributed: '1.5', unattributed: '0' });
    expect(store.slices.get('Y')!.legs.find((l) => l.leg === 'long')!.qty).toBe('1'); // untouched
  });

  it('refuses a recovery that would make a slice negative or not fit the observed position', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    openInto(store, 'X', 'open-x', '1');
    const recover = (delta: string, observedActual: string) => () => store.slices.recover({
      contract: LONG_C, observedActual, evidence: 'x', now: 40, adjustments: [{ sliceId: 'X', leg: 'long', delta }],
    });
    expect(recover('-1.5', '0')).toThrow(SliceRefusal);
    expect(recover('0', '0.5')).toThrow(/fit/);
    expect(rec(store, LONG_C, '1')).toMatchObject({ status: 'reconciled' }); // nothing changed
  });

  it('refuses to recover while execution on the contract is in flight', () => {
    const store = new Store(':memory:');
    twoLegSlice(store, 'X');
    deal(store, 'working', { contract: LONG_C, side: 'BUY' }, null, '1');
    expect(() => store.slices.recover({ contract: LONG_C, observedActual: '0', evidence: 'x', now: 40, adjustments: [] }))
      .toThrow(/in flight/);
  });
});
