/**
 * Ticket 06 — manual control outranks automation.
 *
 * The invariant under test is asymmetric and deliberately one-sided: the
 * `'best'` auto-reprice loop may follow the book as much as it likes, but the
 * instant a user pins a price it must stop, permanently, until the user asks
 * for auto-follow back. Automation must never reverse a human.
 *
 * Driven through the real observe → project → decide → act loop (`tickPair`)
 * against the FakeVenue, so "no self-reprice" is proved by venue calls and
 * persisted state, not by a helper's return value.
 *
 * NOTE on prices: `A_CONTRACT` is a HYPERLIQUID symbol, so `formatRestPrice`
 * applies the five-significant-figure cap. Everything here runs on a 0.1 tick
 * grid near 2500, where every grid value has at most five significant figures —
 * the cap never truncates and the tick math is exact.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from '../../src/engine/loop';
import { A_CONTRACT, B_CONTRACT, mkWorld, assertInvariants, type World } from './engine-sim';

/** Step n ticks, checking venue-truth invariants after every one. */
async function stepChecked(w: World, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await w.step(1);
    assertInvariants(w);
  }
}

function setBook(w: World, bid: string | null, ask: string | null): void {
  w.venue.books.set(A_CONTRACT, { bid, ask });
}

/** A 'best' world on the 0.1 tick grid (5-sig-fig clean), so tick math is exact. */
function bestWorld(over?: Parameters<typeof mkWorld>[0]): World {
  return mkWorld({ pricePolicy: 'best', a: { tick: '0.1' }, ...over });
}

/** Drive until the maker has settled onto `price` (a re-peg is an intent edit:
 * the loop cancels the old resting order and re-places). */
async function settleMaker(w: World, price: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await stepChecked(w, 1);
    if (w.venue.liveOrder(A_CONTRACT)?.price === price) return;
  }
  throw new Error(`maker never settled at ${price}`);
}

describe('manual pin outranks the auto-reprice loop', () => {
  it('a pinned price survives a large book move with no self-reprice', async () => {
    // A deadline far beyond the test horizon: the absolute deadline legitimately
    // ends a maker window, so it must not be what removes the quote here.
    const w = bestWorld({ deadlineInMs: 60 * 60_000 });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    expect(w.venue.liveOrder(A_CONTRACT)!.price).toBe('2500'); // the bare best bid

    // The user types a price: the existing re-peg command pins it. Ticket 02's
    // contract is that this flips pricePolicy, which is what turns the
    // automation off.
    commands.repeg(w.store, w.pairId, '2470', 'fixed');
    await settleMaker(w, '2470');
    expect(w.store.getPair(w.pairId)!.pricePolicy).toBe('fixed');

    const before = w.venue.liveOrder(A_CONTRACT)!;
    const callsBefore = w.venue.bestQuoteCalls.length;

    // The book runs AWAY — far more than the two-tick lag threshold, and with
    // the 15 s interval gate long cleared. If automation could reverse the user
    // this is exactly when it would.
    setBook(w, '2600', '2600.2');
    w.clock.advance(10 * 60_000);
    await stepChecked(w, 12);

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.pricePolicy).toBe('fixed'); // still pinned
    expect(pair.repriceCount).toBe(0); // no automatic cycle was ever consumed
    expect(pair.limitPrice).toBe('2470'); // the intent row was not rewritten
    // The SAME resting order is still live at the user's price — it was neither
    // canceled nor replaced.
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(before.clientText);
    expect(w.venue.liveOrder(A_CONTRACT)!.price).toBe('2470');
    // And the 'best' quote source is not even consulted for a pinned deal.
    expect(w.venue.bestQuoteCalls.length).toBe(callsBefore);
  });

  it('handing control back to automation resumes repricing at the current best', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    commands.repeg(w.store, w.pairId, '2470', 'fixed');
    await settleMaker(w, '2470');

    // The user hands control back: the SAME command, writing auto-follow back
    // with a fresh price. The engine half of that is the policy write.
    const freshBest = await w.venue.bestQuote(A_CONTRACT, 'BUY', '0.1');
    commands.repeg(w.store, w.pairId, freshBest!, 'best');
    await settleMaker(w, '2500');

    expect(w.store.getPair(w.pairId)!.pricePolicy).toBe('best');
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0); // restoring is not a chase

    // Auto-follow is genuinely live again: the book moves two ticks and the
    // loop consumes exactly one cycle.
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(20_000);
    await stepChecked(w, 3);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    expect(w.venue.liveOrder(A_CONTRACT)!.price).toBe('2500.2');
  });

  it('restoring with an explicit price pins instead of tracking', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    commands.repeg(w.store, w.pairId, '2495', 'best'); // tracking
    await settleMaker(w, '2500');

    // Explicit price → 'fixed': the pin wins over the deal's auto-follow family.
    commands.repeg(w.store, w.pairId, '2495', 'fixed');
    await settleMaker(w, '2495');
    setBook(w, '2550', '2550.2');
    w.clock.advance(20_000);
    await stepChecked(w, 6);

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.pricePolicy).toBe('fixed');
    expect(pair.repriceCount).toBe(0);
    expect(w.venue.liveOrder(A_CONTRACT)!.price).toBe('2495');
  });
});

describe('the auto-follow policy a deal restores to is its OWN family policy', () => {
  // 'best' must be remembered across the pin. A pinned deal has pricePolicy
  // 'fixed', so the current policy alone cannot tell a four-leg deal from an
  // ordinary one — the family is a persisted policy value, not a guess from the
  // venue, the symbol or the position.
  it("remembers 'best' as the family policy of a four-leg deal", () => {
    expect(mkWorld({ pricePolicy: 'best' }).store.getPair('p1')!.autoPricePolicy).toBe('best');
  });

  it("an ordinary 'touch' deal restores to 'touch'", () => {
    expect(mkWorld({ pricePolicy: 'touch' }).store.getPair('p1')!.autoPricePolicy).toBe('touch');
  });

  it("a 'fixed'-born deal has no auto-follow family and restores to 'touch'", () => {
    // Preserves the pre-existing behavior of "Re-peg to touch" on a plain
    // pinned deal: it hands the maker back to the book.
    expect(mkWorld({ pricePolicy: 'fixed' }).store.getPair('p1')!.autoPricePolicy).toBe('touch');
  });
});

describe('restoring auto-follow does not paper over a missing quote', () => {
  it('a price-pinned deal is never resurrected into auto-follow without a fresh quote', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    commands.repeg(w.store, w.pairId, '2470', 'fixed');
    await settleMaker(w, '2470');

    // The book goes away entirely. A caller that "restored auto-follow" anyway
    // would silently switch the deal off manually — the exact failure the
    // command's fail-loudly contract exists to prevent. The engine half is that
    // the policy is only written when a caller passes one.
    setBook(w, null, null);
    w.clock.advance(20_000);
    await stepChecked(w, 6);

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.pricePolicy).toBe('fixed'); // still pinned — nothing silently changed
    expect(pair.limitPrice).toBe('2470');
    expect(w.venue.liveOrder(A_CONTRACT)!.price).toBe('2470');
  });
});

describe('pausing or retaining a maker never bypasses the existing safety order', () => {
  // Ticket 04 (parallel) pauses new maker work while the book is unavailable and
  // retains the resting order. These states are the ones that must still win:
  // an in-doubt order freezes placement, a quarantine freezes everything, a
  // persistent hedge wall halts, and a user Stop outranks all of them.
  it('an in-doubt order still freezes placement for a best deal', async () => {
    const w = bestWorld({ b: null });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    // A hedge-shaped taker left PENDING: nothing about the paused/repage path may
    // place on top of it.
    w.store.insertPendingOrder({
      pairId: w.pairId,
      leg: 'B',
      kind: 'taker',
      side: 'SELL',
      qty: '0.01',
      price: null,
      tif: 'ioc',
      now: w.clock.now(),
    });
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(20_000);
    await stepChecked(w, 3);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0); // no reprice while frozen
  });

  it('a quarantine still freezes a best deal and stops all new maker work', async () => {
    const w = bestWorld({ b: null });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.setRawStatus(maker.clientText, 'MYSTERIOUS_STATE_7');
    const createsBefore = w.venue.createCalls.length;
    setBook(w, '2600', '2600.2');
    w.clock.advance(20_000);
    await stepChecked(w, 3);
    expect(w.venue.createCalls.length).toBe(createsBefore); // no new order, no re-placement
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
    expect(w.store.listOrders(w.pairId).some((o) => o.quarantinedStatus !== null)).toBe(true);
  });

  it('a user Convert outranks the best reprice loop', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    commands.convertNow(w.store, w.pairId);
    setBook(w, '2600', '2600.2');
    w.clock.advance(20_000);
    await stepChecked(w, 2);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).not.toBe('OPENING');
    expect(pair.repriceCount).toBe(0); // the chase never starts
  });

  it('a user Stop outranks a pinned best deal', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    commands.repeg(w.store, w.pairId, '2470', 'fixed');
    await settleMaker(w, '2470');

    commands.stop(w.store, w.pairId);
    await stepChecked(w, 4);
    // The stop is honored (the maker is cancelled) and the pin is irrelevant to
    // it — a manual command is never blocked by the quoting policy.
    expect(['STOPPING', 'DONE']).toContain(w.store.getPair(w.pairId)!.mode);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
  });

  it('a persistent hedge wall still halts, and the pin does not mask it', async () => {
    const w = bestWorld({ b: { minNotional: '10' } });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');
    w.venue.refPrices.delete(B_CONTRACT);
    w.clock.advance(20_000);
    await stepChecked(w, 16);
    expect(w.store.getPair(w.pairId)!.mode).toBe('HALTED');
  });
});
