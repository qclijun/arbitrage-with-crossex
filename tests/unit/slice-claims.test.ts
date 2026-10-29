import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/engine/db';
import { previewClaim } from '../../src/engine/claim-preview';
import type { ClaimEvidence, ClaimInput } from '../../src/engine/claim-types';
import { processSliceClaims } from '../../src/engine/slice-claims';
import { reconcileContract } from '../../src/engine/slice-reconcile';
import { floatingApplicability } from '../../web/src/lib/fundingApplicability';
import { parseDecimal18 } from '../../src/core/boros/decimal18';
import { deal, LONG_C, order, SHORT_C, twoLegSlice } from '../helpers/slice-fixture';

const root = `0x${'1'.repeat(40)}`;
const input = (qty = '0.36'): ClaimInput => ({ kind: 'funding-two-leg', boros: [], legs: [
  { contract: LONG_C, side: 'long', qty }, { contract: SHORT_C, side: 'short', qty },
] });
const evidence = (): ClaimEvidence => ({ readAt: 100, positions: { [LONG_C]: '4.03', [SHORT_C]: '-4.03' },
  contracts: [LONG_C, SHORT_C], openOrders: [], boros: null });
let store: Store;
afterEach(() => { vi.useRealTimers(); store?.close(); });
const world = () => { store = new Store(':memory:'); return store; };
function enqueue(id: string, req = input(), ev = evidence()): void {
  store.claims.preview(id, req, previewClaim(store.slices, req, ev, 100), 100);
  store.claims.confirm(id);
}

describe('current-time ownership commands', () => {
  it('bounds unavailable evidence and never applies a late read after rejection', async () => {
    world(); enqueue('one'); vi.useFakeTimers();
    let resolve!: (value: ClaimEvidence) => void;
    const work = processSliceClaims(store, () => new Promise((r) => { resolve = r; }), () => 100);
    await vi.advanceTimersByTimeAsync(1001); await work;
    expect(store.claims.get('one')?.status).toBe('rejected');
    resolve(evidence()); await Promise.resolve();
    expect(store.slices.list()).toEqual([]);
  });
  it('does not rebook settled historical fills included in a new baseline, even at the same millisecond', async () => {
    world();
    deal(store, 'past', { contract: LONG_C, side: 'BUY' }, { contract: SHORT_C, side: 'SELL' }, '1');
    order(store, 'past', 'A', '1', '1'); order(store, 'past', 'B', '1', '1');
    store.updatePair('past', { mode: 'DONE' });
    enqueue('one');
    await processSliceClaims(store, async () => evidence(), () => 100);
    expect(store.claims.get('one')?.status).toBe('applied');
    store.slices.bookPending(101);
    expect(store.slices.book(LONG_C)?.explained).toBe('4.03');
    expect(store.slices.get('claim:one')?.legs[0].qty).toBe('0.36');
    expect(store.slices.movements('claim:one').every((m) => m.kind === 'claim')).toBe(true);
  });
  it('claims only selected actual quantity at the engine time; replay is inert and history stays unknown', async () => {
    world();
    enqueue('one');
    expect(store.slices.list()).toEqual([]);
    await processSliceClaims(store, async () => evidence(), () => 110);
    await processSliceClaims(store, async () => { throw new Error('must not re-read'); }, () => 200);
    const slice = store.slices.get('claim:one')!;
    expect(slice.legs.map((l) => l.qty)).toEqual(['0.36', '0.36']);
    expect(slice.source).toMatchObject({ type: 'current-claim', asOf: 110, readAt: 100 });
    expect(store.slices.movements(slice.id)).toHaveLength(2);
    expect(reconcileContract(store.slices.contractState(LONG_C), '4.03')).toMatchObject({ status: 'reconciled', unattributed: '3.67' });
    expect(store.claims.get('one')).toMatchObject({ status: 'applied', appliedAt: 110,
      preview: { attribution: { funding: null, fees: null, pnl: null, equityReturn: null } } });
    expect(store.listPairs()).toEqual([]);
    const applicability = floatingApplicability({
      slices: store.slices.list().map((s) => ({ ...s, reducible: store.slices.reducible(s.id) })),
      contracts: [LONG_C, SHORT_C].map((contract) => ({ contract, ...reconcileContract(store.slices.contractState(contract), evidence().positions[contract]) })),
    }, [LONG_C, SHORT_C].map((symbol, i) => ({ symbol, base: 'ETH', exchange: i === 0 ? 'BINANCE' : 'OKX', side: i === 0 ? 'LONG' : 'SHORT',
      qty18: parseDecimal18('4.03'), signedQty18: parseDecimal18(i === 0 ? '4.03' : '-4.03') })));
    expect(applicability.known).toBe(true);
    expect(applicability.granted.map((g) => g.qty)).toEqual(['0.36', '0.36']);
  });

  it('rejects a competing preview atomically instead of taking another slice quantity', async () => {
    world(); enqueue('one'); enqueue('two');
    await processSliceClaims(store, async () => evidence(), () => 110);
    await processSliceClaims(store, async () => evidence(), () => 110);
    expect(store.claims.get('two')).toMatchObject({ status: 'rejected', appliedAt: null });
    expect(store.slices.list()).toHaveLength(1);
  });

  it.each(['stale', 'unreadable', 'changed', 'expired'] as const)('does not create a slice when evidence is %s', async (mode) => {
    world(); enqueue('one');
    const ev = evidence();
    if (mode === 'changed') ev.positions[LONG_C] = '5';
    await processSliceClaims(store, async () => {
      if (mode === 'unreadable') throw new Error('network');
      return ev;
    }, () => mode === 'expired' ? 10_101 : mode === 'stale' ? 10_100 : 110);
    expect(store.claims.get('one')?.status).toBe('rejected');
    expect(store.slices.list()).toEqual([]);
  });

  it('refuses external changes and keeps the original difference, movements and alert', () => {
    world(); twoLegSlice(store, 'old', { [LONG_C]: '4', [SHORT_C]: '-4.03' });
    store.alert('error', null, 'past unexplained change', 1);
    expect(() => previewClaim(store.slices, input(), evidence(), 100)).toThrow(/external-change/);
    expect(store.slices.book(LONG_C)?.explained).toBe('4');
    expect(store.slices.movements('old')).toEqual([]);
    expect(store.listAlerts()).toHaveLength(1);
  });

  it.each(['orders', 'engine', 'opposite', 'missing', 'over', 'unequal'] as const)('refuses %s evidence', (mode) => {
    world(); const ev = evidence(); const req = input();
    if (mode === 'orders') ev.openOrders = [LONG_C];
    if (mode === 'engine') deal(store, 'busy', { contract: LONG_C, side: 'BUY' }, null, '1');
    if (mode === 'opposite') ev.positions[LONG_C] = '-4.03';
    if (mode === 'missing') ev.contracts = [];
    if (mode === 'over') req.legs[0].qty = '5';
    if (mode === 'unequal') req.legs[0].qty = '0.1';
    expect(() => previewClaim(store.slices, req, ev, 100)).toThrow();
    expect(store.slices.list()).toEqual([]);
  });

  it('claims a Spread holding physically once with both source directions and leaves 3.67 unattributed', async () => {
    world();
    const req: ClaimInput = { ...input(), kind: 'boros-hedge', root, boros: [{ key: 'spread', qty: '0.36' }] };
    const ev = evidence(); ev.boros = [{ key: 'spread', root, accountId: 0, marketAcc: 'bucket', marketId: 1, base: 'ETH',
      qty: '0.360000000000000001', unit: 'base', maturity: 1000, sources: [{ venue: 'BINANCE', side: 'long' }, { venue: 'OKX', side: 'short' }] }];
    enqueue('boros', req, ev);
    await processSliceClaims(store, async () => ev, () => 110);
    expect(store.claims.get('boros')?.status).toBe('applied');
    expect((store.slices.get('claim:boros')!.source as { boros: unknown[] }).boros).toHaveLength(1);
    expect(() => previewClaim(store.slices, req, ev, 110)).toThrow(/occupied|insufficient/);
  });

  it.each(['missing', 'direction', 'unit', 'maturity', 'duplicate'] as const)('refuses Boros %s without granting floating ownership', (mode) => {
    world();
    const req: ClaimInput = { ...input(), kind: 'boros-hedge', root, boros: [{ key: 'b', qty: '0.36' }] };
    const ev = evidence(); ev.boros = [{ key: 'b', root, accountId: 0, marketAcc: 'bucket', marketId: 1,
      base: 'ETH', qty: '4', unit: 'base', maturity: 1000, sources: [{ venue: 'BINANCE', side: 'long' }, { venue: 'OKX', side: 'short' }] }];
    if (mode === 'missing') ev.boros = null;
    if (mode === 'direction') ev.boros![0].sources[0].side = 'short';
    if (mode === 'unit') ev.boros![0].unit = 'collateral:USDT';
    if (mode === 'maturity') ev.boros![0].maturity = 0;
    if (mode === 'duplicate') req.boros.push(req.boros[0]);
    expect(() => previewClaim(store.slices, req, ev, 100)).toThrow();
    expect(store.slices.list()).toEqual([]);
  });
});
