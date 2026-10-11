/**
 * Book-outage pause and the thirty-second cancel request (ticket 04).
 *
 * Driven through the real observe → project → decide → act loop against the fake
 * venue, which now has a per-contract two-sided book AND two INDEPENDENT failure
 * switches:
 *   - `bookReadsFail` — the BOOK endpoint is down while ORDER status reads still
 *     work. This is the case that arms the cancel.
 *   - `readsFail` — the whole venue is unreachable: order reads fail too, so the
 *     cancel is NOT a safe option and the pause must give way to the existing
 *     unknown-result / freeze rules.
 *
 * The pause grades ONLY by how long the outage lasts (`bookOutageStartedAt`, a
 * persisted fact), never by where the failure lands inside a reprice cycle.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { fx } from '../../src/engine/fx';
import { commands, tickPair, type LoopDeps } from '../../src/engine/loop';
import { TUNING } from '../../src/engine/types';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock, mkWorld, assertInvariants, type World } from './engine-sim';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-book-outage-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

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

/** Place a maker against a healthy two-sided book and return its client text. */
async function placeMaker(w: World, bid = '2499.9', ask = '2500.1'): Promise<string> {
  setBook(w, bid, ask);
  await stepChecked(w);
  const maker = w.venue.liveOrder(A_CONTRACT);
  expect(maker, 'the maker should have been placed').toBeDefined();
  return maker!.clientText;
}

/** How many MAKER (POC) orders were ever submitted — the "no new maker" count.
 * Distinguishes a maker from the taker clips/hedges the convert path emits. */
function pocCreated(w: World): number {
  return [...w.venue.orders.values()].filter((o) => o.tif === 'poc').length;
}

const OUTAGE_MS = TUNING.BOOK_OUTAGE_CANCEL_MS;

describe('book outage: the thirty-second cancel request', () => {
  it('preserves the resting maker under 30s, then requests its cancel past 30s — order reads healthy', async () => {
    const w = bestWorld();
    const makerText = await placeMaker(w);
    const outageStart = w.clock.now(); // the outage begins on the next tick

    w.venue.bookReadsFail = true; // book endpoint down; ORDER status reads still fine

    // 20s of outage: the maker must still be resting (it can still fill), and the
    // outage start must be persisted rather than re-derived each tick.
    await stepChecked(w, 20);
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(makerText);
    const p = w.store.getPair(w.pairId)!;
    expect(p.bookOutageStartedAt).toBe(outageStart);
    expect(p.mode).toBe('OPENING'); // a pause is not a mode change
    expect(p.repriceCount).toBe(0); // and not a reprice

    // Cross the 30s threshold.
    w.clock.advance(OUTAGE_MS - (w.clock.now() - p.bookOutageStartedAt) + 1);
    await stepChecked(w, 1);
    expect(w.venue.orders.get(makerText)!.rawStatus).toBe('CANCELLED');
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0); // a pause cancel consumes no quota

    // And the remaining maker is NOT replaced while the book stays unavailable.
    await stepChecked(w, 3);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
    expect(w.venue.createCalls).toHaveLength(1); // only the original placement
  });
});

describe('book outage: graded by DURATION, never by its position in a reprice cycle', () => {
  interface Timeline {
    createsDuringOutage: number;
    quotaUsed: number;
    liveMaker: boolean;
    mode: string;
    elapsed: number;
  }

  /**
   * Drive a 'best' deal into an outage from two DIFFERENT phases of its reprice
   * lifecycle and report what the loop did while the book stayed down:
   *   - 'inside-cycle'  — a reprice cycle has already issued its cancel (the
   *     maker is gone, the quota unit is spent): the outage lands right AFTER a
   *     cancel / inside the cycle.
   *   - 'between-cycles' — the maker rests cleanly and no reprice is owed: the
   *     outage lands strictly between two cycles.
   */
  async function runOrdering(kind: 'inside-cycle' | 'between-cycles'): Promise<Timeline> {
    const w = bestWorld({ deadlineInMs: 30 * 60_000 });
    const makerText = await placeMaker(w, '2500', '2500.2'); // at the best bid
    w.clock.advance(16_000); // clear the 15 s reprice gate

    if (kind === 'inside-cycle') {
      setBook(w, '2500.2', '2500.4'); // two ticks of lag → a reprice cycle begins
      await stepChecked(w); // the cycle's cancel is issued and CONFIRMED; no replacement yet
      expect(w.venue.orders.get(makerText)!.rawStatus).toBe('CANCELLED');
      expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    }
    // 'between-cycles': nothing moves, so no reprice is owed and the maker rests.

    const createsBefore = w.venue.createCalls.length;
    const quotaBefore = w.store.getPair(w.pairId)!.repriceCount;
    const outageOn = w.clock.now();
    w.venue.bookReadsFail = true; // the book dies HERE — at a different cycle phase per ordering

    await stepChecked(w, 35); // well past the 30 s threshold

    return {
      createsDuringOutage: w.venue.createCalls.length - createsBefore,
      quotaUsed: w.store.getPair(w.pairId)!.repriceCount - quotaBefore,
      liveMaker: w.venue.liveOrder(A_CONTRACT) !== undefined,
      mode: w.store.getPair(w.pairId)!.mode,
      elapsed: w.clock.now() - outageOn,
    };
  }

  it('behaves identically whether the failure began inside or between reprice cycles', async () => {
    const inside = await runOrdering('inside-cycle');
    const between = await runOrdering('between-cycles');

    // The same data interruption, two different cycle phases: the user-visible
    // outcome must be the same. A user cannot be told why an identical outage
    // behaved differently because of where it happened to land.
    for (const t of [inside, between]) {
      expect(t.elapsed).toBeGreaterThan(OUTAGE_MS);
      expect(t.createsDuringOutage).toBe(0); // never quoted into a dead book
      expect(t.quotaUsed).toBe(0); // a pause is not a reprice — no quota consumed
      expect(t.mode).toBe('OPENING'); // a pause is not a mode change
      expect(t.liveMaker).toBe(false); // neither ends the outage with a resting maker
    }
  });
});

describe('book outage: the pause is explainable and never quotes off a stale price', () => {
  it('reports an explainable pause reason while the book is unavailable', async () => {
    const w = bestWorld();
    await placeMaker(w);
    w.venue.bookReadsFail = true;
    const action = await tickPair(w.deps, w.pairId); // the loop's own return value
    expect(action.type).toBe('idle');
    expect((action as { reason: string }).reason).toMatch(/book unavailable/i);
    expect((action as { reason: string }).reason).toMatch(/paused/i);
  });

  it('never falls back to the RETAINED placement price — refuting the old `?? limitPrice` seam', async () => {
    // This is the reversal ticket 02 built for the PLACEMENT path and ticket 04
    // must preserve for the PAUSE: after one successful placement the retained
    // `limitPrice` is non-empty forever (performPlace writes back what it used),
    // so any fallback would make "no book → place nothing" unreachable and
    // re-seed the book with a stale intent price every pause tick.
    const w = bestWorld({ limitPrice: '2500' });
    await placeMaker(w, '2499.9', '2500.1');
    expect(w.store.getPair(w.pairId)!.limitPrice).not.toBeNull(); // the retained price exists...
    expect(w.venue.createCalls).toHaveLength(1);

    w.venue.bookReadsFail = true; // ...and now the book dies
    await stepChecked(w, 35);
    expect(w.venue.createCalls).toHaveLength(1); // never re-placed at the retained price
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined(); // and not resurrected either
  });
});

describe('book outage: a brief failure preserves the maker and keeps hedging', () => {
  it('leaves the resting maker live and hedges a fill that lands during a short outage', async () => {
    const w = bestWorld({ target: '0.152', deadlineInMs: 30 * 60_000 });
    const makerText = await placeMaker(w);

    w.venue.bookReadsFail = true; // brief outage
    await stepChecked(w, 10); // 10 s, well under 30 s
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(makerText); // PRESERVED

    // The preserved maker fills mid-outage: the loop must still observe it and
    // hedge the confirmed fill — a market-data outage is not an execution halt.
    w.venue.fill(makerText, '0.152');
    await stepChecked(w, 3);
    const { aTrue, bTrue } = w.venue.truth();
    expect(aTrue).toBe(fx('0.152'));
    expect(bTrue).toBe(fx('0.152')); // hedged despite the dead book
    // The maker is left resting here (the book is still down, so decide() idles
    // rather than replacing it) — finishing is not what this test pins.
  });
});

describe('book outage: recovery is the loop, with no recovery state', () => {
  it('resumes the SAME deal and RE-COMPUTES the quote when valid data returns before the deadline', async () => {
    const w = bestWorld({ deadlineInMs: 30 * 60_000 });
    const makerText = await placeMaker(w, '2499.9', '2500.1');
    w.clock.advance(16_000);

    w.venue.bookReadsFail = true;
    await stepChecked(w, 10); // a short outage — the maker is preserved
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(makerText);

    // The book comes back, but the market has moved two ticks: the recovered
    // quote is RE-DERIVED from the fresh book, not resumed at the old price.
    w.venue.bookReadsFail = false;
    setBook(w, '2500.1', '2500.3');
    await stepChecked(w, 4); // observe → the outage marker clears → reprice → re-place

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('OPENING'); // same deal, no new window
    expect(pair.bookOutageStartedAt).toBe(0); // the outage is over
    expect(pair.repriceCount).toBe(1); // the returned book drove exactly one reprice
    const repl = w.venue.liveOrder(A_CONTRACT)!;
    expect(repl.clientText).not.toBe(makerText);
    expect(repl.price).toBe('2500.1'); // the FRESH best bid
  });

  it('does not reopen a maker window when the book recovers only AFTER the deadline', async () => {
    const w = bestWorld({ deadlineInMs: 20_000 });
    await placeMaker(w, '2499.9', '2500.1');
    w.venue.bookReadsFail = true;
    await stepChecked(w, 22); // the outage runs the deal PAST its 20 s deadline

    // Deadline outranks the pause: the deal converts while the book is still
    // down, with no new maker window.
    expect(w.store.getPair(w.pairId)!.mode).toBe('CONVERTING');
    expect(pocCreated(w)).toBe(1);

    // The book recovers, but the deadline already passed — no maker window reopens.
    w.venue.bookReadsFail = false;
    setBook(w, '2500.1', '2500.3');
    await stepChecked(w, 3);
    expect(w.store.getPair(w.pairId)!.mode).not.toBe('OPENING');
    expect(pocCreated(w)).toBe(1);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
  });

  it('does not open a maker window at all when the outage outlasts the deadline', async () => {
    const w = bestWorld({ deadlineInMs: 20_000 });
    await placeMaker(w, '2499.9', '2500.1');
    w.venue.bookReadsFail = true;
    await stepChecked(w, 25); // outage runs past the deadline
    // Straight to conversion — never a placement at an unknown price.
    expect(w.store.getPair(w.pairId)!.mode).not.toBe('OPENING');
    expect(pocCreated(w)).toBe(1); // only the original maker, no new window
  });
});

describe('book outage: an unavailable HEDGE reference blocks hedging at any local price', () => {
  it('never hedges a confirmed fill at a retained local price — it follows the cannot-safely-hedge rules', async () => {
    const w = bestWorld({ target: '0.152', deadlineInMs: 30 * 60_000, b: { minNotional: '10' } });
    const makerText = await placeMaker(w);
    w.venue.fill(makerText, '0.152'); // a confirmed maker fill, obligation to hedge

    // The HEDGE reference price disappears while the maker book is fine — the
    // two inputs are graded SEPARATELY (spec).
    w.venue.refPrices.delete(B_CONTRACT);
    await stepChecked(w, 8);

    // No hedge went out at any retained local price: the fill stays UNHEDGED
    // rather than being hedged off a price we do not have.
    expect(w.venue.truth().bTrue).toBe(0n);
    // The hedge-wall rules own the tick: the maker is pulled (stop acquiring
    // exposure we cannot neutralize) and the persistent failure HALTS.
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.hedgeRejectStreak).toBeGreaterThanOrEqual(TUNING.HEDGE_REJECT_HALT);
    expect(pair.mode).toBe('HALTED');
    expect(
      w.store.listAlerts().some((a) => /hedge (wall|failed)|cannot be sized|reference price/i.test(a.message)),
    ).toBe(true);
  });
});

describe('book outage: existing safety states still outrank the pause', () => {
  it('a manual STOP during an outage still stops (and cancels the maker)', async () => {
    const w = bestWorld();
    await placeMaker(w);
    w.venue.bookReadsFail = true;
    commands.stop(w.store, w.pairId);
    await stepChecked(w, 2);
    expect(w.store.getPair(w.pairId)!.mode).not.toBe('OPENING');
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined();
  });

  it('a manual CONVERT during an outage still converts (never a pause)', async () => {
    const w = bestWorld();
    await placeMaker(w);
    w.venue.bookReadsFail = true;
    commands.convertNow(w.store, w.pairId);
    await stepChecked(w, 2);
    expect(w.store.getPair(w.pairId)!.mode).not.toBe('OPENING');
  });

  it('an order in doubt still freezes — the pause does not paper over it', async () => {
    const w = bestWorld();
    await placeMaker(w);
    // A hedge order the venue never delivered: PENDING, fate unresolved.
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
    w.venue.bookReadsFail = true;
    const action = await tickPair(w.deps, w.pairId);
    // The freeze-evasion cancel (stop acquiring unhedgeable exposure) governs,
    // NOT the book-pause idle.
    expect(action.type).toBe('cancel');
    expect((action as { reason?: string }).reason ?? '').not.toMatch(/book unavailable/i);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  });

  it('a HALTED pair stays halted during an outage', async () => {
    const w = bestWorld({ mode: 'HALTED' });
    w.venue.bookReadsFail = true;
    const action = await tickPair(w.deps, w.pairId);
    expect(action).toMatchObject({ type: 'idle', reason: 'halted — awaiting operator' });
  });
});

describe('book outage: an outage AFTER a cancel was already initiated', () => {
  it('never resurrects the original order — confirm the cancel, wait for a valid quote, then replace', async () => {
    const w = bestWorld({ deadlineInMs: 30 * 60_000 });
    const original = await placeMaker(w, '2500', '2500.2');
    w.clock.advance(16_000);
    setBook(w, '2500.2', '2500.4'); // two ticks of lag → a reprice cycle begins

    w.venue.cancelsFail = true; // the cancel is initiated but cannot be confirmed
    await stepChecked(w, 1);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    expect(w.venue.orders.get(original)!.rawStatus).toBe('NEW'); // still live

    // NOW the book dies, post-initiation.
    w.venue.bookReadsFail = true;
    await stepChecked(w, 5);
    // No replacement while the cancel is unconfirmed and the book is down, and
    // no second quota unit for retrying the SAME cycle.
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    expect(w.venue.createCalls).toHaveLength(1);

    // The cancel finally confirms; the order is terminal and NOT resurrected.
    w.venue.cancelsFail = false;
    await stepChecked(w, 2);
    expect(w.venue.orders.get(original)!.rawStatus).toBe('CANCELLED');
    expect(w.venue.liveOrder(A_CONTRACT)).toBeUndefined(); // no replacement into a dead book

    // The book returns: only NOW is the remainder re-placed, at the fresh best.
    w.venue.bookReadsFail = false;
    setBook(w, '2500.4', '2500.6');
    await stepChecked(w, 3);
    const repl = w.venue.liveOrder(A_CONTRACT)!;
    expect(repl.clientText).not.toBe(original);
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(1);
    assertInvariants(w);
  });
});

describe('book outage: the thirty-second grading survives a process restart', () => {
  it('persists the outage start in a FILE-backed store and does NOT reset it on reopen', async () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    let persistedStart = 0;
    {
      const w = mkWorld({ storePath: file, pricePolicy: 'best', a: { tick: '0.1' }, deadlineInMs: 30 * 60_000 });
      await placeMaker(w, '2499.9', '2500.1');
      w.venue.bookReadsFail = true;
      await stepChecked(w, 12); // 12 s into the outage, still under the threshold
      persistedStart = w.store.getPair(w.pairId)!.bookOutageStartedAt;
      expect(persistedStart).toBeGreaterThan(0);
      expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined(); // preserved: under 30 s
      w.store.close(); // release the EXCLUSIVE lock before reopening
    }
    {
      const w = mkWorld({ storePath: file, reopen: true });
      const p = w.store.getPair(w.pairId)!;
      // The outage clock is the PERSISTED fact — not re-derived, not zeroed. A
      // restart must not restart the thirty seconds.
      expect(p.bookOutageStartedAt).toBe(persistedStart);
      w.store.close();
    }
  });
});

describe('book outage: the pause consumes the ONE shared availability predicate', () => {
  it('pauses on a ONE-SIDED book — a legal book object that is not quotable', async () => {
    const w = bestWorld({ deadlineInMs: 30 * 60_000 });
    const makerText = await placeMaker(w, '2500', '2500.2');
    w.clock.advance(16_000);
    setBook(w, '2500', null); // one-sided: a legal `NormalizedBook`, never quotable
    await stepChecked(w, 2);
    expect(w.store.getPair(w.pairId)!.bookOutageStartedAt).toBeGreaterThan(0);
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(makerText); // preserved
    expect(w.venue.createCalls).toHaveLength(1); // no new maker
  });

  it('pauses on a CROSSED book — the other shape the shared predicate rejects', async () => {
    const w = bestWorld({ deadlineInMs: 30 * 60_000 });
    const makerText = await placeMaker(w, '2500', '2500.2');
    w.clock.advance(16_000);
    setBook(w, '2500.4', '2500.2'); // crossed: ask < bid (the pre-change mid helper had NO check)
    await stepChecked(w, 2);
    expect(w.store.getPair(w.pairId)!.bookOutageStartedAt).toBeGreaterThan(0);
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(makerText);
    expect(w.venue.createCalls).toHaveLength(1);
  });
});

describe('book outage: scope isolation — only the four-leg best deal pauses', () => {
  it("never arms the pause for a 'touch' deal (its maker is untouched by the book switch)", async () => {
    const w = mkWorld({ pricePolicy: 'touch', limitPrice: '2500' });
    w.venue.touchA = '2499';
    await stepChecked(w);
    const t = w.venue.liveOrder(A_CONTRACT)!.clientText;
    w.venue.bookReadsFail = true;
    await stepChecked(w, 40); // well past the 30 s threshold
    expect(w.store.getPair(w.pairId)!.bookOutageStartedAt).toBe(0); // never armed
    expect(w.venue.orders.get(t)!.rawStatus).toBe('NEW'); // no pause cancel
  });

  it("never arms the pause for a 'fixed' deal", async () => {
    const w = mkWorld({ pricePolicy: 'fixed', limitPrice: '2500' });
    await stepChecked(w);
    const t = w.venue.liveOrder(A_CONTRACT)!.clientText;
    w.venue.bookReadsFail = true;
    await stepChecked(w, 40);
    expect(w.store.getPair(w.pairId)!.bookOutageStartedAt).toBe(0); // never armed
    expect(w.venue.orders.get(t)!.rawStatus).toBe('NEW'); // no pause cancel
    expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0); // the reprice machinery is best-only too
  });
});

describe('book outage: the copy is honest about the LOCAL limitation', () => {
  it('never describes a lookup as proof that the SOURCE book is fresh', async () => {
    const w = bestWorld();
    await placeMaker(w);
    w.venue.bookReadsFail = true;
    const action = await tickPair(w.deps, w.pairId);
    const reason = (action as { reason?: string }).reason ?? '';
    // The local standard cannot verify the exchange's source-book timestamp, so
    // neither a successful fetch nor a local parse time may be presented as
    // proof of freshness. The pause copy says only that OUR lookup was
    // unavailable — which is what we can actually know.
    expect(reason).toMatch(/book unavailable/i);
    expect(reason).not.toMatch(/fresh|source|timestamp|stale/i);
  });
});

describe('book outage: the whole venue being unreachable is NOT the book being down', () => {
  it('emits NO cancel and follows the unknown-result/freeze rules when order reads also fail', async () => {
    const w = bestWorld();
    const makerText = await placeMaker(w);
    const before = w.clock.now();

    // The WHOLE venue is unreachable: the book is down AND order status reads
    // fail, so a cancel could not be confirmed. The one correct action is none.
    w.venue.readsFail = true;
    await stepChecked(w, 40); // well past 30 s
    expect(w.clock.now() - before).toBeGreaterThan(OUTAGE_MS);
    // Not cancelled, not guessed, not resent, not quarantined on a guess.
    expect(w.venue.orders.get(makerText)!.rawStatus).toBe('NEW');
    expect(w.store.listOrders(w.pairId)[0].quarantinedStatus).toBeNull();
    expect(w.store.listOrders(w.pairId)[0].readFailStreak).toBeGreaterThan(0); // the outage IS visible
    expect(w.venue.createCalls).toHaveLength(1); // nothing new went out
    // ...and no cancel request ever left the engine.
    expect(w.store.listOrders(w.pairId)[0].cancelRequested).toBe(0);

    // Order reads recover while the BOOK stays down: now the duration grades and
    // the cancel is finally requested.
    w.venue.readsFail = false;
    w.venue.bookReadsFail = true;
    await stepChecked(w, 2);
    expect(w.venue.orders.get(makerText)!.rawStatus).toBe('CANCELLED');
  });
});
