/**
 * Post-only reject budget — ticket 05.
 *
 * Under automatic `'best'` quoting the maker rests AT the same-side best, the
 * most easily-crossed position in the book, so a post-only (would-cross) reject
 * is an EXPECTED high-frequency event rather than a "the price is persistently
 * wrong" fault. The old code funneled that reject into the SAME budget as a
 * taker-clip reject/whiff (`pocRejects`, cap 5) and always ended in STOPPING
 * (honest partial fill) — so one book jitter could cut off the taker completion
 * path the user is entitled to after the deadline, stranding the deal short.
 *
 * Ticket 05 gives a `'best'` deal a SEPARATE post-only budget (cap 20) whose
 * destination is CONVERTING (complete the remainder with taker). The two budgets
 * never consume each other, and — the regression that matters most — ordinary
 * (non-`'best'`) deals, single opens, closes and existing deals keep the OLD
 * budget, limit and destination, unchanged.
 */
import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/engine/types';
import { fx } from '../../src/engine/fx';
import { A_CONTRACT, B_CONTRACT, mkWorld, assertInvariants, assertHonestReport, type World } from './engine-sim';

/** Step n ticks, checking venue-truth invariants after every one. */
async function stepChecked(w: World, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await w.step(1);
    assertInvariants(w);
  }
}

/** Step until the pair reaches DONE (or the cap), checking invariants. Returns
 * the PEAK post-only count observed along the way — the counter is a consecutive
 * streak, so a completing fill legitimately clears it before the end. */
async function driveToDone(w: World, max = 400): Promise<number> {
  let peak = 0;
  for (let i = 0; i < max; i++) {
    peak = Math.max(peak, w.store.getPair(w.pairId)!.postOnlyRejects);
    if (w.store.getPair(w.pairId)!.mode === 'DONE') return peak;
    await w.step(1);
    assertInvariants(w);
  }
  return peak;
}

function setBook(w: World, bid: string, ask: string): void {
  w.venue.books.set(A_CONTRACT, { bid, ask });
}

/** A 'best' world on the 0.1 tick grid (5-sig-fig clean), so tick math is exact. */
function bestWorld(over?: Parameters<typeof mkWorld>[0]): World {
  return mkWorld({ pricePolicy: 'best', a: { tick: '0.1' }, ...over });
}

describe('post-only budget exhaustion converts and completes with taker', () => {
  it('reaches CONVERTING at 20 post-only rejects and fills the remainder with taker', async () => {
    const w = bestWorld({ target: '0.152', deadlineInMs: 30 * 60_000 });
    setBook(w, '2499.9', '2500.1');
    // Every maker create is rejected as a would-cross post-only order, well past
    // the OLD cap of 5 — so the deal must NOT stop there.
    w.venue.nextCreate = Array(TUNING.MAX_POST_ONLY_REJECTS).fill('reject:POC_FILL_IMMEDIATELY');
    const peak = await driveToDone(w);

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(peak).toBe(TUNING.MAX_POST_ONLY_REJECTS); // the NEW budget was reached, not the old 5
    expect(pair.pocRejects).toBe(0); // the OLD budget was never touched

    // It COMPLETED the remainder with taker instead of stopping at partial fill.
    const report = JSON.parse(pair.reportJson!) as { aFilled: string; bFilled: string };
    expect(report.aFilled).toBe('0.152');
    expect(report.bFilled).toBe('0.152');
    assertHonestReport(w);

    // ...and the completion really was a taker clip on leg A, not another maker.
    const aOrders = [...w.venue.orders.values()].filter((o) => o.contract === A_CONTRACT);
    expect(aOrders.some((o) => o.tif === 'ioc')).toBe(true);
  });

  it('does NOT enter CONVERTING before the post-only budget is exhausted', async () => {
    const w = bestWorld({ target: '0.152', deadlineInMs: 30 * 60_000 });
    setBook(w, '2499.9', '2500.1');
    // One short of the cap. The deal must still be OPENING and still be retrying.
    w.venue.nextCreate = Array(TUNING.MAX_POST_ONLY_REJECTS - 1).fill('reject:POC_FILL_IMMEDIATELY');
    await stepChecked(w, 120);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.postOnlyRejects).toBe(TUNING.MAX_POST_ONLY_REJECTS - 1);
    expect(pair.mode).toBe('OPENING'); // NOT converted, NOT stopped
    expect(pair.pocRejects).toBe(0);
  });
});

describe('the post-only budget is independent of the other two budgets', () => {
  it('exhausting the post-only budget consumes neither the reprice quota nor the clip budget', async () => {
    const w = bestWorld({ target: '0.152', deadlineInMs: 30 * 60_000 });
    setBook(w, '2499.9', '2500.1');
    w.venue.nextCreate = Array(TUNING.MAX_POST_ONLY_REJECTS).fill('reject:POC_FILL_IMMEDIATELY');
    const peak = await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(peak).toBe(TUNING.MAX_POST_ONLY_REJECTS); // this budget was spent to the cap
    expect(pair.repriceCount).toBe(0); // the reprice quota is untouched
    expect(pair.pocRejects).toBe(0); // the clip budget is untouched
  });

  it('exhausting the reprice quota consumes none of the post-only budget', async () => {
    // Single leg (no hedge obligation) to isolate the reprice cap; the book moves
    // two ticks per cycle so every cycle is owed — exactly ticket 02's cap setup.
    const w = bestWorld({ target: '0.3', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    let bidTenths = 25000;
    for (let cycle = 0; cycle < 40; cycle++) {
      bidTenths += 2; // +0.2 = two ticks of lag
      const bid = (bidTenths / 10).toFixed(1);
      setBook(w, bid, (bidTenths / 10 + 0.2).toFixed(1));
      w.clock.advance(16_000); // clear the 15s gate
      await stepChecked(w, 3);
    }
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.repriceCount).toBe(TUNING.MAX_REPRICE_CYCLES); // this one is spent
    expect(pair.postOnlyRejects).toBe(0); // the post-only budget is untouched
    expect(pair.pocRejects).toBe(0);
    expect(pair.mode).toBe('OPENING'); // and the cap alone never converts
  });
});

describe('taker-clip failures keep the OLD budget and destination', () => {
  it('a rejected taker clip does NOT restart conversion — it stops honestly', async () => {
    // A 'best' deal whose post-only budget is spent enters CONVERTING, then every
    // taker clip is rejected (e.g. REDUCE_ONLY: the position vanished). That must
    // draw the OLD budget and STOP honestly — never re-enter CONVERTING, which
    // would retry forever.
    const w = bestWorld({ target: '0.152', mode: 'CONVERTING', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2499.9', '2500.1');
    w.store.updatePair(w.pairId, { postOnlyRejects: TUNING.MAX_POST_ONLY_REJECTS }); // pre-spent
    w.venue.nextCreate = Array(20).fill('reject:REDUCE_ONLY');
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(pair.pocRejects).toBe(TUNING.MAX_POC_REJECTS); // bounded by the OLD budget
    expect(w.venue.createCalls.length).toBeLessThanOrEqual(TUNING.MAX_POC_REJECTS + 1);
    const report = JSON.parse(pair.reportJson!) as { aFilled: string; reason: string };
    expect(report.aFilled).toBe('0');
    expect(report.reason).toContain('failing repeatedly');
  });

  it('a whiffed taker clip (accepted, zero fill) also stops honestly on the OLD budget', async () => {
    const w = bestWorld({ target: '0.152', mode: 'CONVERTING', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2499.9', '2500.1');
    w.venue.nextIocFill = Array(20).fill(0); // every clip whiffs
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(pair.pocRejects).toBe(TUNING.MAX_POC_REJECTS);
    expect(w.venue.createCalls.length).toBeLessThanOrEqual(TUNING.MAX_POC_REJECTS + 1);
    expect(JSON.parse(pair.reportJson!).reason).toContain('failing repeatedly');
  });
});

/**
 * Frozen limits, as an INDEPENDENT source of truth. The regression tests below
 * assert against `TUNING.MAX_POC_REJECTS`; without this guard those assertions
 * would be tautological (they would keep passing if the constant itself were
 * changed). Ticket 05 must not move the OLD limits by one character.
 */
describe('the existing budgets are frozen (independent guard)', () => {
  it('keeps MAX_POC_REJECTS at 5 and HEDGE_REJECT_HALT at 3', () => {
    expect(TUNING.MAX_POC_REJECTS).toBe(5);
    expect(TUNING.HEDGE_REJECT_HALT).toBe(3);
  });

  it('sets the new post-only budget to 20 — same magnitude as the reprice quota, and larger than the old cap', () => {
    expect(TUNING.MAX_POST_ONLY_REJECTS).toBe(20);
    expect(TUNING.MAX_POST_ONLY_REJECTS).toBe(TUNING.MAX_REPRICE_CYCLES);
    expect(TUNING.MAX_POST_ONLY_REJECTS).toBeGreaterThan(TUNING.MAX_POC_REJECTS);
  });
});

/**
 * THE REGRESSION THAT MATTERS MOST (ticket 05): the EXISTING budget's
 * semantics, limit and destination must not change by one character. Ordinary
 * perpetual pairs, single opens, closes and existing deals keep "reject a few
 * times (5), then honest partial fill (STOPPING)". Each case below asserts both
 * the OLD outcome AND that the new post-only counter stayed 0.
 */
describe('ordinary deals keep the existing reject-budget semantics (no regression)', () => {
  it('an ordinary FIXED pair still stops honestly at 5 rejects, post-only budget untouched', async () => {
    const w = mkWorld({ pricePolicy: 'fixed', limitPrice: '2500' });
    w.venue.nextCreate = Array(TUNING.MAX_POC_REJECTS).fill('reject:POC_FILL_IMMEDIATELY');
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(pair.pocRejects).toBe(TUNING.MAX_POC_REJECTS); // the OLD budget, at its OLD cap
    expect(pair.postOnlyRejects).toBe(0); // the new budget is NOT used off the 'best' path
    const report = JSON.parse(pair.reportJson!) as { aFilled: string; reason: string };
    expect(report.aFilled).toBe('0');
    expect(report.reason).toMatch(/crossing the market/);
  });

  it('an ordinary TOUCH pair keeps the OLD budget and the OLD honest-partial-fill destination', async () => {
    const w = mkWorld({ pricePolicy: 'touch' });
    w.venue.touchA = '2500';
    w.venue.nextCreate = Array(TUNING.MAX_POC_REJECTS).fill('reject:POC_FILL_IMMEDIATELY');
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(pair.pocRejects).toBe(TUNING.MAX_POC_REJECTS);
    expect(pair.postOnlyRejects).toBe(0);
    expect(JSON.parse(pair.reportJson!).reason).toMatch(/crossing the market/);
  });

  it('a single-leg maker open (no hedge leg) keeps the OLD reject budget', async () => {
    const w = mkWorld({ b: null, pricePolicy: 'fixed', target: '0.1' });
    w.venue.nextCreate = Array(TUNING.MAX_POC_REJECTS).fill('reject:POC_FILL_IMMEDIATELY');
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(pair.pocRejects).toBe(TUNING.MAX_POC_REJECTS);
    expect(pair.postOnlyRejects).toBe(0);
  });

  it('a close (CONVERTING reduce-only) keeps the OLD clip budget and honest stop', async () => {
    const w = mkWorld({
      mode: 'CONVERTING',
      b: null,
      a: { side: 'SELL', reduceOnly: true },
      target: '0.1',
    });
    w.venue.nextCreate = Array(10).fill('reject:REDUCE_ONLY');
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(pair.pocRejects).toBe(TUNING.MAX_POC_REJECTS);
    expect(pair.postOnlyRejects).toBe(0);
    expect(JSON.parse(pair.reportJson!).reason).toContain('failing repeatedly');
  });
});

describe('post-only rejections across the OPENING → CONVERTING boundary', () => {
  it('rejections spent during OPENING do NOT cut off the CONVERTING completion', async () => {
    // The deal opens and accumulates post-only rejections (staying under the
    // cap), then the deadline arrives and it converts. CONVERTING must complete
    // the remainder with taker — the accumulated OPENING rejections must NOT be
    // read as an A-leg wall that stops it honestly at partial fill.
    const w = bestWorld({ target: '0.152', deadlineInMs: 10_000 });
    setBook(w, '2499.9', '2500.1');
    w.venue.nextCreate = Array(4).fill('reject:POC_FILL_IMMEDIATELY');
    await stepChecked(w, 9); // several post-only rejections while OPENING (2s backoff each)
    const mid = w.store.getPair(w.pairId)!;
    expect(mid.mode).toBe('OPENING');
    expect(mid.postOnlyRejects).toBe(4);
    expect(mid.pocRejects).toBe(0); // the OPENING rejections touched ONLY the new budget

    w.clock.advance(10_000); // cross the absolute deadline
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    const report = JSON.parse(pair.reportJson!) as { aFilled: string; bFilled: string };
    expect(report.aFilled).toBe('0.152'); // completed with taker, NOT stopped at 0
    expect(report.bFilled).toBe('0.152');
    assertHonestReport(w);
  });
});

/** The terminal report must reflect CONFIRMED venue fills — honest even when
 * the venue refuses the remainder. */
describe('terminal report is based on confirmed venue fills', () => {
  it('after converting, reports the completed target and says so (not a failure)', async () => {
    const w = bestWorld({ target: '0.152', deadlineInMs: 30 * 60_000 });
    setBook(w, '2499.9', '2500.1');
    w.venue.nextCreate = Array(TUNING.MAX_POST_ONLY_REJECTS).fill('reject:POC_FILL_IMMEDIATELY');
    await driveToDone(w);
    const report = JSON.parse(w.store.getPair(w.pairId)!.reportJson!) as { aFilled: string; bFilled: string; reason: string };
    assertHonestReport(w); // report == venue truth, byte for byte
    expect(report.aFilled).toBe('0.152');
    expect(report.reason).not.toContain('failing repeatedly');
    expect(report.reason).toContain('converted');
  });

  it('when the venue refuses the remainder, reports the confirmed fills honestly (no false "done")', async () => {
    const w = bestWorld({ target: '0.152', mode: 'CONVERTING', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2499.9', '2500.1');
    w.store.updatePair(w.pairId, { postOnlyRejects: TUNING.MAX_POST_ONLY_REJECTS });
    w.venue.nextCreate = Array(20).fill('reject:REDUCE_ONLY'); // the venue will not take the remainder
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    assertHonestReport(w); // aFilled/bFilled == venue truth (0 here), never an invented number
    const report = JSON.parse(pair.reportJson!) as { aFilled: string; reason: string };
    expect(report.aFilled).toBe('0'); // nothing confirmed filled
    expect(report.reason).toContain('failing repeatedly'); // named honestly, not 'converted'
  });
});

describe('non-rejects consume no post-only budget', () => {
  it('is NOT incremented by ordinary observation ticks while the maker rests', async () => {
    const w = bestWorld({ target: '0.3', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2500', '2500.2');
    await stepChecked(w, 10);
    const pair = w.store.getPair(w.pairId)!;
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined(); // a maker is resting
    expect(pair.postOnlyRejects).toBe(0);
  });

  it('is NOT consumed by an automatic reprice-cycle cancel (a chase is not a reject)', async () => {
    const w = bestWorld({ target: '0.3', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    setBook(w, '2500.2', '2500.4'); // two ticks behind
    w.clock.advance(15_000);
    await stepChecked(w, 3); // one reprice cycle consumed
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.repriceCount).toBe(1);
    expect(pair.postOnlyRejects).toBe(0); // a reprice is not a post-only reject
  });

  it('a network/book read failure consumes no post-only budget', async () => {
    const w = bestWorld({ target: '0.3', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2500', '2500.2');
    await stepChecked(w);
    w.venue.bookReadsFail = true; // the book endpoint is down; nothing is placeable
    await stepChecked(w, 5);
    expect(w.store.getPair(w.pairId)!.postOnlyRejects).toBe(0);
  });
});

describe('the post-only budget never reaches a non-best deal (headline regression)', () => {
  it('an ordinary pair handed 20 rejections still stops honestly at 5 — never completes with taker', async () => {
    // The single most important assertion in this ticket: if the routing leaked,
    // this ordinary pair would blow past 5 and CONVERT — completing a remainder
    // the user never asked the four-leg flow to chase. It must not.
    const w = mkWorld({ pricePolicy: 'fixed', limitPrice: '2500' });
    w.venue.nextCreate = Array(20).fill('reject:POC_FILL_IMMEDIATELY');
    await driveToDone(w);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(pair.pocRejects).toBe(5); // the OLD cap, hit exactly — not 20
    expect(w.venue.createCalls.length).toBe(5); // exactly the old budget's attempts
    const report = JSON.parse(pair.reportJson!) as { aFilled: string; reason: string };
    expect(report.aFilled).toBe('0');
    // 'crossing the market' is the OPENING → STOPPING haltReason: the OLD
    // destination. A conversion would read 'converted'.
    expect(report.reason).toMatch(/crossing the market/);
    expect(report.reason).not.toContain('converted');
    // No taker clip was ever attempted on leg A.
    const aOrders = [...w.venue.orders.values()].filter((o) => o.contract === A_CONTRACT);
    expect(aOrders.every((o) => o.tif === 'poc')).toBe(true);
  });
});

describe('conversion’s A-leg budget counts only conversion-phase failures (problem A)', () => {
  it('OPENING post-only rejects are not added to the budget read during CONVERTING', async () => {
    // Four post-only rejects land while OPENING. The deadline then converts the
    // deal and the taker clips whiff twice before one fills. pocRejects — the
    // counter CONVERTING reads — must be just those two conversion failures (2),
    // NOT 4 + 2 = 6: the OPENING rejections live on the separate counter and can
    // never be spent against the conversion path.
    const w = bestWorld({ target: '0.152', deadlineInMs: 10_000 });
    setBook(w, '2499.9', '2500.1');
    w.venue.nextCreate = Array(4).fill('reject:POC_FILL_IMMEDIATELY');
    await stepChecked(w, 9);
    expect(w.store.getPair(w.pairId)!.postOnlyRejects).toBe(4);
    expect(w.store.getPair(w.pairId)!.pocRejects).toBe(0); // nothing on the conversion budget yet

    w.clock.advance(10_000); // deadline → CONVERTING
    w.venue.nextIocFill = [0, 0, 1]; // two whiffs, then a full fill
    let sawTwo = false;
    for (let i = 0; i < 60; i++) {
      await w.step(1);
      const p = w.store.getPair(w.pairId)!;
      if (p.pocRejects === 2) sawTwo = true;
      if (p.mode === 'DONE') break;
    }
    expect(sawTwo).toBe(true); // conversion failures counted as 2, never 6

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    // The completing A-leg fill clears the streak (consecutive semantics); the
    // OPENING value of 4 was asserted before conversion, above.
    expect(pair.postOnlyRejects).toBe(0);
    const report = JSON.parse(pair.reportJson!) as { aFilled: string };
    expect(report.aFilled).toBe('0.152'); // completed despite the OPENING rejections
  });
});

describe('the post-only budget counts a CONSECUTIVE streak', () => {
  it('resets when an A-leg order closes with a fill (a successful rest ends the streak)', async () => {
    const w = bestWorld({ target: '0.3', b: null, deadlineInMs: 30 * 60_000 });
    setBook(w, '2499.9', '2500.1');
    w.venue.nextCreate = [
      'reject:POC_FILL_IMMEDIATELY',
      'reject:POC_FILL_IMMEDIATELY',
      'reject:POC_FILL_IMMEDIATELY',
      'reject:POC_FILL_IMMEDIATELY',
      'ok', // the fifth placement rests at the best
    ];
    await stepChecked(w, 12);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    expect(maker).toBeDefined();
    expect(w.store.getPair(w.pairId)!.postOnlyRejects).toBe(4);

    // The quote rests and fills — the streak of CONSECUTIVE rejections is over.
    // (Like `pocRejects`, the reset fires when the A-leg order closes having
    // executed; a still-open partial order has not ended the streak.)
    w.venue.fill(maker.clientText, '0.3');
    await stepChecked(w, 3);
    expect(w.store.getPair(w.pairId)!.postOnlyRejects).toBe(0); // streak cleared
  });
});
