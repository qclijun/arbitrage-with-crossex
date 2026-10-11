/**
 * End-to-end tests for the four-leg 'best' quote mode, driven through the real
 * observe → project → decide → act loop (`tickPair`) against the fake venue.
 *
 * These exercise the full seam: the venue's two-sided book, the maker placement
 * at the bare same-side best, the bounded auto-reprice cycle (cancel → confirm →
 * reconcile → hedge-first → re-place), and the persisted reprice facts.
 *
 * NOTE on prices: the maker contract `A_CONTRACT` is a HYPERLIQUID symbol, so
 * `formatRestPrice` applies the five-significant-figure cap. The tick-boundary
 * tests below therefore use a `0.1` tick on a ~2500 price (every 0.1-grid value
 * near 2500 has at most five significant figures, so the cap never truncates and
 * the tick math is exact). The truncation behaviour itself is asserted
 * deliberately at a magnitude where it DOES give up ticks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/engine/db';
import { TUNING } from '../../src/engine/types';
import { fx } from '../../src/engine/fx';
import { A_CONTRACT, B_CONTRACT, mkWorld, assertInvariants, type World } from './engine-sim';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-best-quote-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

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

describe("'best' initial placement", () => {
  it('posts a BUY maker at the best BID (bare, no spread offset)', async () => {
    const w = bestWorld({ a: { tick: '0.1', side: 'BUY' } });
    setBook(w, '2499.9', '2500.1'); // bare best bid 2499.9
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    expect(maker).toBeDefined();
    expect(maker.side).toBe('BUY');
    expect(maker.tif).toBe('poc'); // post-only
    expect(maker.price).toBe('2499.9');
    // A 'touch' quote rests a whole gap behind: 2·2499.9 − 2500.1 = 2499.7.
    expect(maker.price).not.toBe('2499.7');
  });

  it('posts a SELL maker at the best ASK', async () => {
    const w = bestWorld({ a: { tick: '0.1', side: 'SELL' } });
    setBook(w, '2499.7', '2500.1'); // bare best ask 2500.1
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    expect(maker.side).toBe('SELL');
    expect(maker.tif).toBe('poc');
    expect(maker.price).toBe('2500.1');
    // 'touch' for SELL would be 2·2500.1 − 2499.7 = 2500.5.
    expect(maker.price).not.toBe('2500.5');
  });

  it('applies the Hyperliquid 5-sig-fig cap in the SAFE direction at a large magnitude', async () => {
    const w = mkWorld({ pricePolicy: 'best', a: { side: 'BUY', tick: '0.01' } });
    setBook(w, '61717.85', '61717.90'); // 6 sig figs → must truncate DOWN for a BUY
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    expect(maker.price).toBe('61717');
  });

  it('places NOTHING when the book is one-sided — and never falls back to the retained price', async () => {
    const w = bestWorld({ limitPrice: '2500' });
    setBook(w, '2500', null); // one-sided: a legal object, not a quotable book
    await stepChecked(w, 3);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
    expect(w.venue.createCalls).toHaveLength(0);
  });

  it('places NOTHING when the book is crossed', async () => {
    const w = bestWorld();
    setBook(w, '2500.5', '2500.1'); // crossed
    await stepChecked(w, 3);
    expect(w.venue.createCalls).toHaveLength(0);
  });
});

describe("'best' scope isolation", () => {
  it("never consults the 'best' quote source for a 'fixed' deal", async () => {
    const w = mkWorld({ pricePolicy: 'fixed', limitPrice: '2500' });
    setBook(w, '2499.9', '2500.1');
    await stepChecked(w, 3);
    expect(w.venue.bestQuoteCalls).toHaveLength(0);
    expect(w.venue.liveOrder(A_CONTRACT)!.price).toBe('2500');
  });

  it("never consults the 'best' quote source for a 'touch' deal", async () => {
    const w = mkWorld({ pricePolicy: 'touch' });
    setBook(w, '2499.9', '2500.1');
    w.venue.touchA = '2499.7';
    await stepChecked(w, 3);
    expect(w.venue.bestQuoteCalls).toHaveLength(0);
    // 'touch' still rests at the OLD one-gap-behind price, unchanged.
    expect(w.venue.liveOrder(A_CONTRACT)!.price).toBe('2499.7');
  });
});

describe("'best' bounded auto-reprice — boundaries through the full loop", () => {
  it('does NOT reprice when the quote is less than two ticks behind', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2'); // place at best bid 2500
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    expect(maker.price).toBe('2500');
    setBook(w, '2500.1', '2500.3'); // one tick behind
    await stepChecked(w, 20); // well past 15s
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(maker.clientText); // same order
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  });

  it('DOES reprice at exactly two ticks of lag once 15s have passed', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w); // place at 2500
    const first = w.venue.liveOrder(A_CONTRACT)!.clientText;
    setBook(w, '2500.2', '2500.4'); // two ticks behind

    await stepChecked(w); // t=1s: too soon → still resting
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(first);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);

    w.clock.advance(15_000); // clear the 15s gate
    await stepChecked(w, 3); // cancel → confirm → re-place
    const after = w.store.getPair(w.pairId)!;
    expect(after.repriceCount).toBe(1);
    const repl = w.venue.liveOrder(A_CONTRACT)!;
    expect(repl.clientText).not.toBe(first); // a NEW client id, no duplicate
    expect(repl.price).toBe('2500.2'); // re-quoted at the new best bid
  });

  it('does NOT reprice before 15s even with a large lag', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const first = w.venue.liveOrder(A_CONTRACT)!.clientText;
    setBook(w, '2502', '2502.2'); // TWENTY ticks behind
    for (let i = 0; i < 14; i++) await stepChecked(w); // t reaches 14s
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(first);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  });

  it('NEVER cancels a quote that is at or more aggressive than the best', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const first = w.venue.liveOrder(A_CONTRACT)!.clientText;
    setBook(w, '2499', '2499.2'); // best drops BELOW our resting BUY → more aggressive
    await stepChecked(w, 20);
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(first);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  });

  it('a formatted best never produces an infinite re-place loop at a truncation-heavy magnitude', async () => {
    // At ~61717.85 the 5-sig-fig cap gives up several ticks; the placed price is
    // the FORMATTED 61717. Measuring lag against the FORMATTED best (61717) is 0,
    // so the quote is never deemed behind and never re-placed forever. Comparing
    // the formatted resting price against a RAW 61717.85 would have been a
    // multi-tick lag every tick — an endless cancel/replace.
    const w = mkWorld({ pricePolicy: 'best', a: { tick: '0.01' }, limitPrice: '61717' });
    setBook(w, '61717.85', '61717.90');
    await stepChecked(w);
    expect(w.venue.liveOrder(A_CONTRACT)!.price).toBe('61717');
    const first = w.venue.liveOrder(A_CONTRACT)!.clientText;
    await stepChecked(w, 30); // many ticks, well past 15s
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(first);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  });
});

describe("'best' reprice cycle — cancel-then-replace and fill reconciliation", () => {
  it('confirms the cancel (order terminal) BEFORE placing the replacement', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const first = w.venue.liveOrder(A_CONTRACT)!.clientText;
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(15_000);
    await stepChecked(w); // cancels the old order
    expect(w.venue.orders.get(first)!.rawStatus).toBe('CANCELLED');
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined(); // no replacement yet
    await stepChecked(w, 3);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined();
  });

  it('hedges a fill that lands DURING the reprice cancel exactly once, with no over-acquire', async () => {
    const w = bestWorld({ target: '0.152' });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(15_000);
    w.venue.nextCancelRace.push(0.5); // half the remaining fills as the cancel lands
    await stepChecked(w, 4);

    const { aTrue, bTrue } = w.venue.truth();
    expect(aTrue).toBe(fx('0.076')); // half of 0.152 filled on the maker
    expect(bTrue).toBe(fx('0.076')); // hedged exactly once, promptly
    assertInvariants(w);
    const repl = w.venue.liveOrder(A_CONTRACT)!;
    expect(repl.qty).toBe(fx('0.076')); // replacement covers only the remainder
  });

  it('a partial fill is hedged at market promptly — the deal finishes without waiting out the window', async () => {
    const w = bestWorld({ target: '0.152', deadlineInMs: 30 * 60_000 });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.152');
    await stepChecked(w, 4);
    const { aTrue, bTrue } = w.venue.truth();
    expect(aTrue).toBe(fx('0.152'));
    expect(bTrue).toBe(fx('0.152'));
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(w.clock.now()).toBeLessThan(pair.deadlineAt!); // done well before the deadline
  });
});

describe("'best' reprice quota — monotone, capped, never consumed by non-reprices", () => {
  it('is NOT consumed by a post-only rejection', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    w.venue.nextCreate = ['insta-cancel', 'ok'];
    await stepChecked(w, 2);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
    // Ticket 05 moved a 'best' post-only reject onto its OWN counter (destination
    // CONVERTING); the old shared clip budget is deliberately left at 0 here.
    expect(w.store.getPair(w.pairId)!.pocRejects).toBe(0);
    expect(w.store.getPair(w.pairId)!.postOnlyRejects).toBe(1);
  });

  it('is NOT consumed by a book-anomaly idle (no reprice while the book is invalid)', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    setBook(w, '2500.2', '2500.4'); // a lag exists...
    w.clock.advance(15_000);
    setBook(w, '2500.2', null); // ...but the book is now one-sided
    await stepChecked(w, 5);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  });

  it('is NOT consumed by network observation alone (idle ticks never reprice)', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w, 10);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  });

  it('is NOT reset when the maker fills (unlike pocRejects)', async () => {
    const w = bestWorld({ target: '0.3', b: null });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(15_000);
    await stepChecked(w, 3); // one reprice consumed
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05'); // a partial fill
    await stepChecked(w, 2);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1); // NOT cleared by the fill
  });

  it('caps at 20 cycles and, once exhausted, keeps the last quote live without converting', async () => {
    // Single leg (no hedge obligation) to isolate the reprice cap; the book moves
    // two ticks each cycle so a reprice is always owed.
    const w = bestWorld({ target: '0.3', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    let bidTenths = 25000; // 2500.0
    for (let cycle = 0; cycle < 40; cycle++) {
      bidTenths += 2; // +0.2 = two ticks
      const bid = (bidTenths / 10).toFixed(1);
      setBook(w, bid, (bidTenths / 10 + 0.2).toFixed(1));
      w.clock.advance(16_000); // clear the 15s gate
      await stepChecked(w, 3);
    }
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.repriceCount).toBe(TUNING.MAX_REPRICE_CYCLES);
    // The last quote is still live — exhausting the cap does NOT convert to taker.
    expect(pair.mode).toBe('OPENING');
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined();
  });
});

describe("'best' reprice facts survive a restart", () => {
  it('does not reset repriceCount or lastMakerPlacementAt across a process restart', async () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    {
      const w = mkWorld({ storePath: file, pricePolicy: 'best', a: { tick: '0.1' } });
      setBook(w, '2500', '2500.2');
      await stepChecked(w);
      setBook(w, '2500.2', '2500.4');
      w.clock.advance(15_000);
      await stepChecked(w, 3);
      const p = w.store.getPair(w.pairId)!;
      expect(p.repriceCount).toBe(1);
      expect(p.lastMakerPlacementAt).toBeGreaterThan(0);
      w.store.close(); // release the EXCLUSIVE lock before reopening
    }
    {
      const w = mkWorld({ storePath: file, reopen: true });
      const p = w.store.getPair(w.pairId)!;
      expect(p.repriceCount).toBe(1); // NOT reset
      expect(p.lastMakerPlacementAt).toBeGreaterThan(0); // NOT reset
      w.store.close();
    }
  });
});

describe("'best' crash-injection at the cancel commit boundary", () => {
  it('reconciles cancel-race fills and stops safely when the post-send transaction fails', async () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    const w = bestWorld({ storePath: file });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(15_000);
    w.venue.nextCancelRace.push(0.5);
    const update = w.store.updatePair.bind(w.store);
    const failure = vi.spyOn(w.store, 'updatePair').mockImplementation((id, patch) => {
      if (patch.repriceCount !== undefined) throw new Error('sim: persistence failure');
      update(id, patch);
    });
    await expect(w.step()).rejects.toThrow('sim: persistence failure');
    failure.mockRestore();
    w.store.close();
    w.store = new Store(file);
    w.deps.store = w.store;
    await stepChecked(w, 5);
    expect(w.store.getPair(w.pairId)!.mode).toBe('DONE');
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
    expect(w.venue.createCalls).toHaveLength(2); // original maker + one final hedge
    expect(w.venue.truth().aTrue).toBe(fx('0.076'));
    expect(w.venue.truth().bTrue).toBe(w.venue.truth().aTrue);
    w.store.close();
  });

  it('starts the cancel before charging it, and rolls back both facts if persistence fails', async () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    const w = bestWorld({ storePath: file });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const first = w.venue.liveOrder(A_CONTRACT)!.clientText;
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(15_000);
    const cancel = w.venue.cancel.bind(w.venue);
    w.venue.cancelsFail = true;
    const wire = vi.spyOn(w.venue, 'cancel').mockImplementation((ref) => {
      expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
      return cancel(ref);
    });
    const update = w.store.updatePair.bind(w.store);
    const failure = vi.spyOn(w.store, 'updatePair').mockImplementation((id, patch) => {
      if (patch.repriceCount !== undefined) throw new Error('sim: persistence failure');
      update(id, patch);
    });
    await expect(w.step()).rejects.toThrow('sim: persistence failure');
    expect(wire).toHaveBeenCalledTimes(1);
    failure.mockRestore();
    wire.mockRestore();
    w.store.close();
    w.store = new Store(file);
    w.deps.store = w.store;
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
    expect(w.store.listOrders(w.pairId).find((o) => o.clientId === first)!.cancelRequested).toBe(0);
    w.venue.cancelsFail = false;
    await stepChecked(w, 4);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).not.toBe(first);
    w.store.close();
  });

  it('consumes exactly ONE quota unit when a crash aborts the tick right after the reprice commit', async () => {
    let crashNext = false;
    const file = path.join(tempDir(), 'deals.sqlite');
    const w = bestWorld({ storePath: file, crashAfterCommit: () => crashNext });
    setBook(w, '2500', '2500.2');
    await stepChecked(w); // place
    const first = w.venue.liveOrder(A_CONTRACT)!.clientText;
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(15_000);

    w.venue.cancelsFail = true;
    crashNext = true; // abort after initiation + commit, before processing the unknown outcome
    await w.step(1);
    crashNext = false;
    const mid = w.store.getPair(w.pairId)!;
    expect(mid.repriceCount).toBe(1); // consumed at the commit boundary
    const order = w.store.listOrders(w.pairId).find((o) => o.clientId === first)!;
    expect(order.cancelRequested).toBe(1);
    expect(w.venue.orders.get(first)!.rawStatus).toBe('NEW'); // initiated, outcome unknown
    w.store.close();
    w.store = new Store(file);
    w.deps.store = w.store;
    w.venue.cancelsFail = false;

    // Recovery: the next tick re-sends the cancel idempotently WITHOUT a second
    // quota unit, then re-places once the order is terminal.
    await stepChecked(w, 4);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1); // NOT double-counted
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined();
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).not.toBe(first);
    assertInvariants(w);
    w.store.close();
  });
});

describe('four-leg reference-book safety', () => {
  it('cancels acquisition and hedges no fill on a crossed B reference, then catches up after recovery', async () => {
    const w = bestWorld({ b: { minNotional: '5' } });
    await stepChecked(w);
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.076');
    w.venue.books.set(B_CONTRACT, { bid: '2501', ask: '2499' });
    await stepChecked(w, 2);
    expect(w.venue.truth().bTrue).toBe(0n);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
    expect(w.store.getPair(w.pairId)!.hedgeRejectStreak).toBeGreaterThan(0);
    w.venue.books.set(B_CONTRACT, { bid: '2499', ask: '2501' });
    w.clock.advance(TUNING.HEDGE_BACKOFF_MS);
    await stepChecked(w);
    expect(w.venue.truth().bTrue).toBe(w.venue.truth().aTrue);
  });

  it('does not acquire converting clips using an invalid A reference', async () => {
    const w = bestWorld({ mode: 'CONVERTING', a: { minNotional: '5' } });
    w.venue.books.set(A_CONTRACT, { bid: '2501', ask: '2499' });
    await stepChecked(w, 2);
    expect(w.venue.createCalls).toHaveLength(0);
    expect(w.store.getPair(w.pairId)!.mode).toBe('CONVERTING');
    w.venue.books.set(A_CONTRACT, { bid: '2499', ask: '2501' });
    await stepChecked(w, 4);
    expect(w.store.getPair(w.pairId)!.mode).toBe('DONE');
    expect(w.venue.truth().aTrue).toBe(w.venue.truth().bTrue);
  });

  it('does not lose the placement interval when restoring an initially fixed quote', async () => {
    const w = bestWorld();
    w.store.updatePair(w.pairId, { pricePolicy: 'fixed' });
    await stepChecked(w);
    expect(w.store.getPair(w.pairId)!.lastMakerPlacementAt).toBeGreaterThan(0);
    w.store.updatePair(w.pairId, { pricePolicy: 'best' });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    setBook(w, '2500.2', '2500.4');
    await stepChecked(w);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  });
});

describe("'best' reprice quota is not double-counted on an unknown or retried cancel", () => {
  it('counts ONE unit across an unconfirmed cancel that is re-sent every tick', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const first = w.venue.liveOrder(A_CONTRACT)!.clientText;
    setBook(w, '2500.2', '2500.4');
    w.clock.advance(15_000);

    w.venue.cancelsFail = true; // the venue cannot confirm the cancel
    await stepChecked(w, 6); // the reprice cancel is initiated, then retried repeatedly
    // Exactly ONE unit: the first initiation. Retries of the SAME cycle add none.
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    // The order is still live — an unconfirmed cancel must not be assumed terminal.
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(first);

    // Venue recovers: the cancel lands, the order goes terminal, and only THEN is
    // the remainder re-placed — still without a second unit.
    w.venue.cancelsFail = false;
    await stepChecked(w, 4);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    const repl = w.venue.liveOrder(A_CONTRACT)!;
    expect(repl.clientText).not.toBe(first);
    assertInvariants(w);
  });

  it('a NON-reprice cancel (protecting the unhedged side) consumes no quota', async () => {
    const w = bestWorld();
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!.clientText;
    // A hedge order is left PENDING (never delivered) → an OPENING pair with a
    // resting maker must cancel that maker to stop acquiring exposure it cannot
    // hedge. That cancel is NOT a chase, so it must not draw the reprice quota.
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
    setBook(w, '2500.2', '2500.4'); // a lag exists, but the freeze takes priority
    w.clock.advance(15_000);
    await stepChecked(w, 2);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
    // The maker was canceled (venue-side) by the freeze-evasion cancel.
    expect(w.venue.orders.get(maker)!.rawStatus).toBe('CANCELLED');
  });
});

describe("'best' leg B stays a taker", () => {
  it('hedges at market (ioc), never resting', async () => {
    const w = bestWorld({ target: '0.152' });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.152');
    await stepChecked(w, 3);
    const b = [...w.venue.orders.values()].filter((o) => o.contract === B_CONTRACT);
    for (const o of b) expect(o.tif).toBe('ioc');
    expect(b.reduce((s, o) => s + o.cum, 0n)).toBe(fx('0.152'));
  });
});
