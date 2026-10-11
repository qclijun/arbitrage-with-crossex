/** Pure-function tests: fx arithmetic, projections, sizing, decide edges. */
import { describe, expect, it } from 'vitest';
import { fx, fxFloorToStep, fxStr } from '../../src/engine/fx';
import { clipBandPrice, decide, lagTicks, project, sizeFor } from '../../src/engine/decide';
import { TUNING, type OrderRow, type PairRow } from '../../src/engine/types';
import type { DecideCtx } from '../../src/engine/decide';
import { legSpec, A_CONTRACT, B_CONTRACT } from './engine-sim';

const ctx: DecideCtx = { touchA: '2500', bestA: '2500', bookOutageObservedAt: null, refB: '2500', refA: '2500', maxClip: '1000000' };

function pairRow(over?: Partial<PairRow>): PairRow {
  return {
    id: 'p1',
    mode: 'OPENING',
    a: legSpec(A_CONTRACT, 'BUY'),
    b: legSpec(B_CONTRACT, 'SELL'),
    targetQty: '0.152',
    limitPrice: '2500',
    pricePolicy: 'fixed',
    autoPricePolicy: 'touch',
    deadlineAt: null,
    makerNotBefore: 0,
    hedgeNotBefore: 0,
    pocRejects: 0,
    hedgeRejectStreak: 0,
    repriceCount: 0,
    lastMakerPlacementAt: 0,
    postOnlyRejects: 0,
    bookOutageStartedAt: 0,
        maxClip: null,
    clipBandBp: null,
    haltReason: null,
    reportJson: null,
    createdAt: 0,
    ...over,
  };
}

function order(over: Partial<OrderRow>): OrderRow {
  return {
    pairId: 'p1',
    leg: 'A',
    seq: 1,
    clientId: 't-p1.A1',
    kind: 'maker',
    side: 'BUY',
    qty: '0.152',
    price: '2500',
    tif: 'poc',
    state: 'OPEN',
    venueOrderId: 'V1',
    cumQty: '0',
    avgFillPrice: '0',
    closeReason: null,
    cancelRequested: 0,
    quarantinedStatus: null,
    venueReason: null,
    readFailStreak: 0,
    createdAt: 0,
    resolvedAt: null,
    ...over,
  };
}

/** A leg-B hedge row (taker IOC), so freeze cases can be exercised without a maker. */
function hedgeOrder(over?: Partial<OrderRow>): OrderRow {
  return order({
    leg: 'B',
    seq: 2,
    clientId: 't-p1.B2',
    kind: 'taker',
    side: 'SELL',
    price: null,
    tif: 'ioc',
    ...over,
  });
}

describe('fx', () => {
  it('parses, formats, floors exactly', () => {
    expect(fxStr(fx('0.152'))).toBe('0.152');
    expect(fxStr(fx('0'))).toBe('0');
    expect(fxStr(fxFloorToStep(fx('0.152'), fx('0.1')))).toBe('0.1');
    expect(fxStr(fxFloorToStep(fx('0.152'), fx('0.001')))).toBe('0.152');
    expect(fxStr(fx('0.05') + fx('0.102'))).toBe('0.152'); // no float drift, ever
    expect(() => fx('1e-3')).toThrow();
  });
});

describe('project (reservation accounting)', () => {
  it('reserves full qty for PENDING/OPEN, cum for CLOSED, zero for DEAD', () => {
    const pair = pairRow();
    const p = project(pair, [
      order({ seq: 1, state: 'CLOSED', cumQty: '0.05', qty: '0.152' }),
      order({ seq: 2, state: 'OPEN', qty: '0.102', cumQty: '0.01' }),
      order({ leg: 'B', kind: 'taker', seq: 1, clientId: 't-p1.B1', state: 'PENDING', qty: '0.05', cumQty: '0' }),
      order({ leg: 'B', kind: 'taker', seq: 2, clientId: 't-p1.B2', state: 'DEAD', qty: '0.01', cumQty: '0' }),
    ]);
    expect(p.aFilled).toBe('0.06'); // 0.05 + 0.01
    expect(p.aReserved).toBe('0.152'); // 0.05 (closed cum) + 0.102 (open qty)
    expect(p.bReserved).toBe('0.05'); // pending counts FULL; dead counts 0
    expect(p.unhedged).toBe('0.01'); // 0.06 − 0.05
    expect(p.residualA).toBe('0'); // target fully reserved
    expect(p.anyPending).toBe(true);
  });
});

describe('clipBandPrice (Hyperliquid 5-sig-fig cap)', () => {
  const hl = (side: 'BUY' | 'SELL'): Parameters<typeof clipBandPrice>[1] =>
    legSpec('HYPERLIQUID_FUTURE_BTC_USDC', side, { tick: '0.1' });
  const gate = (side: 'BUY' | 'SELL'): Parameters<typeof clipBandPrice>[1] =>
    legSpec('GATE_FUTURE_BTC_USDT', side, { tick: '0.1' });

  const sigFigs = (s: string): number => s.replace(/[.-]/g, '').replace(/^0+/, '').length;

  it('caps an HL banded price to ≤5 significant figures (the live 422 case)', () => {
    // ref 65964, BUY band 10bp → ~65970.7 → HL rejects 6 sig figs. Must cap.
    const px = clipBandPrice('65964', hl('BUY'), 10);
    expect(sigFigs(px)).toBeLessThanOrEqual(5);
    // Band-preserving direction kept: a BUY limit never exceeds ref·(1+band).
    expect(Number(px)).toBeLessThanOrEqual(65964 * 1.001 + 1e-6);
  });

  it('caps an HL SELL band without ever pricing below ref·(1−band)', () => {
    const px = clipBandPrice('65964', hl('SELL'), 10);
    expect(sigFigs(px)).toBeLessThanOrEqual(5);
    expect(Number(px)).toBeGreaterThanOrEqual(65964 * 0.999 - 1e-6);
  });

  it('leaves non-HL venues at full tick precision (no sig-fig cap)', () => {
    const px = clipBandPrice('65964', gate('BUY'), 10);
    expect(sigFigs(px)).toBeGreaterThan(5); // 66029.9 — Gate allows it
  });
});

describe('sizeFor', () => {
  it('floors to lot, zeroes below minSize/minNotional, never rounds up', () => {
    expect(fxStr(sizeFor(fx('0.152'), legSpec(B_CONTRACT, 'SELL', { lot: '0.1' }), null)!)).toBe('0.1');
    expect(fxStr(sizeFor(fx('0.05'), legSpec(B_CONTRACT, 'SELL', { minSize: '0.1' }), null)!)).toBe('0');
    // minNotional 200 at price 2500: 0.05*2500=125 < 200 → 0
    expect(
      fxStr(sizeFor(fx('0.05'), legSpec(B_CONTRACT, 'SELL', { minNotional: '200' }), '2500')!),
    ).toBe('0');
    // minNotional needs a price: null ref → null ("cannot size safely")
    expect(sizeFor(fx('0.05'), legSpec(B_CONTRACT, 'SELL', { minNotional: '200' }), null)).toBeNull();
  });
});

describe('decide edges', () => {
  it('freezes on any PENDING order', () => {
    const pair = pairRow();
    const p = project(pair, [order({ state: 'PENDING', venueOrderId: null })]);
    expect(decide(pair, p, 0, ctx)).toEqual({ type: 'idle', reason: 'frozen: order in doubt' });
  });

  it('freezes on any quarantined order', () => {
    const pair = pairRow();
    // A quarantined HEDGE with no maker resting: nothing is acquiring, so the
    // freeze is the whole answer. (A quarantined order alongside a RESTING maker
    // is a different case — see the cancel test below.)
    const p = project(pair, [hedgeOrder({ quarantinedStatus: 'WEIRD' })]);
    expect(decide(pair, p, 0, ctx).type).toBe('idle');
  });

  // The freeze blocks PLACEMENT, which stops the hedge — but a maker already
  // resting on the venue keeps filling, so exposure grows with nothing
  // neutralizing it. And because no hedge order is ever submitted,
  // bumpHedgeWall never fires, hedgeRejectStreak stays 0, and HALTED is
  // unreachable: the deal quietly goes fully directional at target size.
  it.each([
    ['in doubt', { state: 'PENDING' as const, venueOrderId: null }],
    ['quarantined', { quarantinedStatus: 'WEIRD' }],
  ])('cancels a resting maker while the hedge is %s', (_label, over) => {
    const pair = pairRow();
    const maker = order({ state: 'OPEN' });
    const p = project(pair, [maker, hedgeOrder(over)]);
    expect(decide(pair, p, 0, ctx)).toEqual({ type: 'cancel', order: maker });
  });

  it('does not cancel a maker that is merely still in doubt itself', () => {
    // A freshly-placed maker is PENDING for its own resolution window; cancelling
    // on that would kill every maker the instant it was submitted.
    const pair = pairRow();
    const p = project(pair, [order({ state: 'PENDING', venueOrderId: null })]);
    expect(decide(pair, p, 0, ctx)).toEqual({ type: 'idle', reason: 'frozen: order in doubt' });
  });

  it('hedge outranks everything, in every live mode', () => {
    for (const mode of ['OPENING', 'CONVERTING', 'STOPPING'] as const) {
      const pair = pairRow({ mode });
      const p = project(pair, [order({ state: 'CLOSED', cumQty: '0.05', closeReason: 'filled' })]);
      const a = decide(pair, p, 0, ctx);
      expect(a).toMatchObject({ type: 'place', leg: 'B', tif: 'ioc', qty: '0.05' });
    }
  });

  it('never places the maker blind (no price → idle)', () => {
    const pair = pairRow({ pricePolicy: 'touch', limitPrice: null });
    const p = project(pair, []);
    expect(decide(pair, p, 0, { ...ctx, touchA: null }).type).toBe('idle');
  });

  it('deadline is a level: fires even when it passed long ago (e.g. during downtime)', () => {
    const pair = pairRow({ deadlineAt: 1_000 });
    const p = project(pair, [order({ state: 'OPEN' })]);
    expect(decide(pair, p, 999_999_999, ctx)).toMatchObject({ type: 'setMode', mode: 'CONVERTING' });
  });

  it('exhausted POC budget: stops with the cause in haltReason, never a bare "stopped"', () => {
    const pair = pairRow({ pocRejects: TUNING.MAX_POC_REJECTS });
    const a = decide(pair, project(pair, []), 0, ctx);
    expect(a).toMatchObject({ type: 'setMode', mode: 'STOPPING' });
    // haltReason is what STOPPING's finishIfSettled writes into the report.
    expect((a as { haltReason?: string }).haltReason).toMatch(/crossing the market/);
  });

  it('a venue cancel that is NOT ours is a STOP; our own cancel is not', () => {
    const pair = pairRow();
    const stop = decide(
      pair,
      project(pair, [order({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 0 })]),
      0,
      ctx,
    );
    expect(stop).toMatchObject({ type: 'setMode', mode: 'STOPPING' });
    const ours = decide(
      pair,
      project(pair, [order({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1 })]),
      0,
      ctx,
    );
    expect(ours.type).not.toBe('setMode'); // converges (re-places) instead
  });

  it('a poc insta-cancel is NOT a STOP', () => {
    const pair = pairRow();
    const a = decide(
      pair,
      project(pair, [order({ state: 'CLOSED', closeReason: 'poc-reject', cancelRequested: 0 })]),
      0,
      ctx,
    );
    expect(a.type).toBe('place'); // requotes
  });

  it('re-peg: live maker at a stale price gets canceled', () => {
    const pair = pairRow({ limitPrice: '2499' });
    const p = project(pair, [order({ state: 'OPEN', price: '2500' })]);
    expect(decide(pair, p, 0, ctx)).toMatchObject({ type: 'cancel' });
  });

  it('convert waits for the hedge before clipping (hedge-first gating)', () => {
    const pair = pairRow({ mode: 'CONVERTING', hedgeNotBefore: 99_999 }); // hedge in backoff
    const p = project(pair, [order({ state: 'CLOSED', cumQty: '0.05', closeReason: 'filled' })]);
    const a = decide(pair, p, 0, ctx);
    expect(a.type).toBe('idle'); // owes a hedge; must not widen the gap with a clip
  });
});

describe('OPENING pauses acquisition while a failed hedge waits out its backoff', () => {
  const backoff = { hedgeNotBefore: 5_000, hedgeRejectStreak: 1 };
  const partlyFilled = (over?: Partial<OrderRow>): OrderRow => order({ state: 'OPEN', cumQty: '0.05', ...over });
  const cancelled = (): OrderRow => partlyFilled({ state: 'CLOSED', closeReason: 'cancelled', cancelRequested: 1 });

  it('cancels the resting maker', () => {
    const pair = pairRow(backoff);
    const maker = partlyFilled();
    expect(decide(pair, project(pair, [maker]), 0, ctx)).toEqual({ type: 'cancel', order: maker });
  });

  it('re-sends the cancel while an unconfirmed one leaves the maker OPEN', () => {
    const pair = pairRow(backoff);
    const maker = partlyFilled({ cancelRequested: 1 });
    expect(decide(pair, project(pair, [maker]), 0, ctx)).toEqual({ type: 'cancel', order: maker });
  });

  it('places no new maker once the old one is closed', () => {
    const pair = pairRow(backoff);
    expect(decide(pair, project(pair, [cancelled()]), 0, ctx)).toEqual({
      type: 'idle',
      reason: 'acquisition paused: hedge failed, waiting out its backoff',
    });
  });

  it('sends the hedge first once the backoff is over', () => {
    const pair = pairRow(backoff);
    expect(decide(pair, project(pair, [cancelled()]), 5_000, ctx)).toEqual({
      type: 'place',
      leg: 'B',
      kind: 'taker',
      tif: 'ioc',
      qty: '0.05',
    });
  });
});

describe("'best' quote mode — initial placement", () => {
  const bestMaker = (over?: Partial<OrderRow>): OrderRow => order({ price: '2500', ...over });

  it('places the maker at the BARE fresh best when the book is quotable', () => {
    const pair = pairRow({ pricePolicy: 'best' });
    const a = decide(pair, project(pair, []), 0, { ...ctx, bestA: '2501.5' });
    expect(a).toMatchObject({ type: 'place', leg: 'A', kind: 'maker', tif: 'poc', price: '2501.5' });
  });

  it('places NOTHING when no fresh best is available — never falls back to the retained price', () => {
    // This is the reversal of the current `ctx.touchA ?? pair.limitPrice`
    // fallback: after one successful placement `limitPrice` is non-empty, so a
    // fallback would make "no book → place nothing" unreachable.
    const pair = pairRow({ pricePolicy: 'best', limitPrice: '2500' });
    const a = decide(pair, project(pair, []), 0, { ...ctx, bestA: null });
    expect(a.type).toBe('idle');
    expect(a).toMatchObject({ reason: expect.stringContaining('no price available') });
  });

  it('posts post-only (tif poc) — an aggressive quote can never silently take', () => {
    const pair = pairRow({ pricePolicy: 'best' });
    const a = decide(pair, project(pair, []), 0, { ...ctx, bestA: '2500' });
    expect(a).toMatchObject({ type: 'place', tif: 'poc' });
  });
});

describe("'best' quote mode — reprice boundaries", () => {
  // lagTicks is the pure metric; both sides are FORMATTED prices in one grid.
  it('counts whole ticks of lag; a more-aggressive quote is 0, never negative', () => {
    expect(lagTicks('2499.98', '2500', '0.01', 'BUY')).toBe(2);
    expect(lagTicks('2499.99', '2500', '0.01', 'BUY')).toBe(1);
    expect(lagTicks('2500', '2500', '0.01', 'BUY')).toBe(0);
    expect(lagTicks('2500.05', '2500', '0.01', 'BUY')).toBe(0); // more aggressive
    expect(lagTicks('2500.02', '2500', '0.01', 'SELL')).toBe(2);
    expect(lagTicks('2499.98', '2500', '0.01', 'SELL')).toBe(0); // more aggressive
  });

  // A resting maker placed by a 'best' deal: its price IS the intent (placement
  // wrote it back), so the re-peg branch does not fire and only the lag metric
  // decides. The lag comes from the book moving away from that resting price.
  const restingAt = (price: string): OrderRow => order({ state: 'OPEN', price });

  it('does NOT reprice below the two-tick threshold', () => {
    const pair = pairRow({ pricePolicy: 'best', limitPrice: '2499.99', lastMakerPlacementAt: 0 });
    const p = project(pair, [restingAt('2499.99')]);
    const a = decide(pair, p, 60_000, { ...ctx, bestA: '2500' });
    expect(a).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('DOES reprice at exactly two ticks of lag', () => {
    const pair = pairRow({ pricePolicy: 'best', limitPrice: '2499.98', lastMakerPlacementAt: 0 });
    const p = project(pair, [restingAt('2499.98')]);
    const a = decide(pair, p, 60_000, { ...ctx, bestA: '2500' });
    expect(a).toMatchObject({ type: 'cancel', reprice: true });
  });

  it('does NOT reprice before 15s since the last maker PLACEMENT', () => {
    const pair = pairRow({ pricePolicy: 'best', limitPrice: '2499.98', lastMakerPlacementAt: 0 });
    const p = project(pair, [restingAt('2499.98')]);
    const a = decide(pair, p, 14_999, { ...ctx, bestA: '2500' });
    expect(a).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('DOES reprice at/after 15s since the last maker placement', () => {
    const pair = pairRow({ pricePolicy: 'best', limitPrice: '2499.98', lastMakerPlacementAt: 0 });
    const p = project(pair, [restingAt('2499.98')]);
    expect(decide(pair, p, 15_000, { ...ctx, bestA: '2500' })).toMatchObject({ type: 'cancel', reprice: true });
  });

  it('NEVER cancels a quote at the best or more aggressive merely to chase', () => {
    for (const px of ['2500', '2500.01', '2500.5']) {
      const pair = pairRow({ pricePolicy: 'best', limitPrice: px, lastMakerPlacementAt: 0 });
      const p = project(pair, [restingAt(px)]);
      expect(decide(pair, p, 60_000, { ...ctx, bestA: '2500' }).type).toBe('idle');
    }
  });

  it('does not reprice when the book is not quotable (no fresh best)', () => {
    const pair = pairRow({ pricePolicy: 'best', limitPrice: '2499.98', lastMakerPlacementAt: 0 });
    const p = project(pair, [restingAt('2499.98')]);
    expect(decide(pair, p, 60_000, { ...ctx, bestA: null })).toEqual({
      type: 'idle',
      reason: 'maker resting',
    });
  });

  it('does not reprice once the 20-cycle quota is exhausted — the last quote stays live', () => {
    const pair = pairRow({
      pricePolicy: 'best',
      limitPrice: '2499.98',
      lastMakerPlacementAt: 0,
      postOnlyRejects: 0,
      bookOutageStartedAt: 0,
      repriceCount: TUNING.MAX_REPRICE_CYCLES,
    });
    const p = project(pair, [restingAt('2499.98')]);
    expect(decide(pair, p, 60_000, { ...ctx, bestA: '2500' })).toEqual({
      type: 'idle',
      reason: 'maker resting',
    });
  });

  it('a formatted-lag comparison never livelocks: a quote already AT the formatted best is lag 0', () => {
    // At a magnitude where the 5-sig-fig cap gives up several ticks, the resting
    // price the engine actually placed is the FORMATTED one. Comparing that
    // formatted price against the formatted best is lag 0, so it does not chase
    // forever the way an unformatted-vs-formatted comparison would.
    const hl = 'HYPERLIQUID_FUTURE_ETH_USDC';
    const pair = pairRow({
      a: legSpec(hl, 'BUY', { tick: '0.01' }),
      pricePolicy: 'best',
      limitPrice: '61717',
      lastMakerPlacementAt: 0,
      postOnlyRejects: 0,
      bookOutageStartedAt: 0,
    });
    const p = project(pair, [restingAt('61717')]); // what formatRestPrice produced
    expect(decide(pair, p, 60_000, { ...ctx, bestA: '61717' })).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('book outage: under BOOK_OUTAGE_CANCEL_MS the maker is preserved (idle, explainable)', () => {
    const start = 100_000;
    const pair = pairRow({ pricePolicy: 'best', bookOutageStartedAt: start, lastMakerPlacementAt: 0 });
    const p = project(pair, [restingAt('2500')]);
    const a = decide(pair, p, start + TUNING.BOOK_OUTAGE_CANCEL_MS - 1, {
      ...ctx,
      bestA: null,
      bookOutageObservedAt: start + TUNING.BOOK_OUTAGE_CANCEL_MS - 1,
    });
    expect(a.type).toBe('idle');
    expect((a as { reason: string }).reason).toMatch(/book unavailable/i);
  });

  it('book outage: at BOOK_OUTAGE_CANCEL_MS the maker cancel is requested', () => {
    const start = 100_000;
    const pair = pairRow({ pricePolicy: 'best', bookOutageStartedAt: start, lastMakerPlacementAt: 0 });
    const p = project(pair, [restingAt('2500')]);
    const a = decide(pair, p, start + TUNING.BOOK_OUTAGE_CANCEL_MS, {
      ...ctx,
      bestA: null,
      bookOutageObservedAt: start + TUNING.BOOK_OUTAGE_CANCEL_MS,
    });
    // Not a reprice: a pause cancel must NOT draw the reprice quota (spec).
    expect(a).toMatchObject({ type: 'cancel' });
    expect((a as { reprice?: boolean }).reprice).toBeUndefined();
  });

  it('book outage: NO cancel is possible when the whole venue is unreachable (no observable)', () => {
    const start = 100_000;
    const pair = pairRow({ pricePolicy: 'best', bookOutageStartedAt: start, lastMakerPlacementAt: 0 });
    const p = project(pair, [restingAt('2500')]);
    // bookOutageObservedAt null is the loop's certification that order-status
    // reads FAILED this tick: the cancel's own outcome would be unknown, so the
    // one correct action is none — never a guess, never a resend.
    const a = decide(pair, p, start + 10 * TUNING.BOOK_OUTAGE_CANCEL_MS, { ...ctx, bestA: null });
    expect(a).toEqual({ type: 'idle', reason: 'maker resting' });
  });

  it('book outage: an already-initiated cancel is re-confirmed idempotently', () => {
    const start = 100_000;
    const pair = pairRow({ pricePolicy: 'best', bookOutageStartedAt: start, lastMakerPlacementAt: 0 });
    const p = project(pair, [order({ state: 'OPEN', price: '2500', cancelRequested: 1 })]);
    const a = decide(pair, p, start + 1_000, { ...ctx, bestA: null, bookOutageObservedAt: start + 1_000 });
    expect(a).toMatchObject({ type: 'cancel' }); // retried, not swallowed by the pause
  });
});
