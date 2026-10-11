/**
 * The maker deadline is an ABSOLUTE fact of the deal: written once when the
 * deal is created and never rewritten by any later event. This is a property
 * of the existing engine, asserted here rather than built: the exploration
 * confirmed `deadlineAt` has exactly one writer (`createPair`). `PairPatch` /
 * `PAIR_COLS` carry a latent `deadlineAt` column, so a future "extend the
 * window" change would be the first code to move it — these tests are the
 * guard that makes such a change loud.
 *
 * Driven through the whole observe → project → decide → act loop against the
 * fake venue. The headline is always the SAME fact: the persisted deadline
 * never moves. A consequence — that the deadline still fires to CONVERTING
 * after every one of these events — is asserted alongside it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { fxStr } from '../../src/engine/fx';
import { commands, tickPair, type LoopDeps } from '../../src/engine/loop';
import type { PairRow } from '../../src/engine/types';
import {
  A_CONTRACT,
  B_CONTRACT,
  FakeVenue,
  VirtualClock,
  assertInvariants,
  legSpec,
  mkWorld,
  type World,
} from './engine-sim';

/** The four-leg window, as `resolveDeal` persists it. */
const FOUR_LEG_WINDOW_MS = 30 * 60 * 1000;

/** The four-leg quote mode: the deal these properties are about is a four-leg
 * deal, so exercise it with the flow's real marker. */
const POLICY = 'best' as const;

async function stepChecked(w: World, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await w.step(1);
    assertInvariants(w);
  }
}

const deadlineOf = (w: World): number | null => w.store.getPair(w.pairId)!.deadlineAt;

describe('the maker deadline never moves', () => {
  it('a partial fill does not extend it', async () => {
    const w = mkWorld({ pricePolicy: POLICY, deadlineInMs: FOUR_LEG_WINDOW_MS });
    await stepChecked(w); // place the maker
    const before = deadlineOf(w);

    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05'); // a partial fill lands
    await stepChecked(w, 2); // observe the fill + hedge it

    expect(fxStr(w.venue.truth().aTrue)).toBe('0.05'); // the fill is real
    expect(deadlineOf(w)).toBe(before);
  });

  it('a reprice (re-peg) does not extend it', async () => {
    // 'fixed' so the explicit re-peg price is what rests (a 'touch' pair would
    // re-derive from the book); the deadline fact is the same either way.
    const w = mkWorld({ pricePolicy: 'fixed', deadlineInMs: FOUR_LEG_WINDOW_MS });
    await stepChecked(w);
    const before = deadlineOf(w);
    const first = w.venue.liveOrder(A_CONTRACT)!;

    // Re-peg the maker remainder to a new price, then let the loop converge:
    // cancel the old order, re-place at the new price. The policy is left as-is
    // (the same shape the "Re-peg to price" command writes).
    commands.repeg(w.store, w.pairId, '2490');
    await stepChecked(w, 3);
    expect(deadlineOf(w)).toBe(before);

    const live = w.venue.liveOrder(A_CONTRACT)!;
    expect(live.clientText).not.toBe(first.clientText); // it really re-placed
    expect(live.price).toBe('2490'); // at the new intent price
    expect(deadlineOf(w)).toBe(before);
  });

  it('a book anomaly does not extend it, and the deadline still fires', async () => {
    const w = mkWorld({ pricePolicy: POLICY, deadlineInMs: FOUR_LEG_WINDOW_MS });
    await stepChecked(w);
    const before = deadlineOf(w);
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    w.venue.fill(maker.clientText, '0.05');

    // The venue becomes unreadable: no order observation, no prices.
    w.venue.readsFail = true;
    await stepChecked(w, 3);
    expect(deadlineOf(w)).toBe(before); // untouched by the outage

    // The deadline is absolute, not paused: cross it and the deal converts.
    w.venue.readsFail = false;
    w.clock.advance(FOUR_LEG_WINDOW_MS + 1_000);
    await stepChecked(w, 1);
    expect(w.store.getPair(w.pairId)!.mode).toBe('CONVERTING');
    expect(deadlineOf(w)).toBe(before);
  });

  it('a UI remount is not a deal event at all — the row is rewritten from the same value', async () => {
    // The web layer holds no deadline state: it renders `pair.deadlineAt` from
    // GET /deals/:id (DealModal). The store round-trip below IS that read, and
    // it must return the same absolute instant, not a recomputed one.
    const w = mkWorld({ pricePolicy: POLICY, deadlineInMs: FOUR_LEG_WINDOW_MS });
    await stepChecked(w);
    const before = deadlineOf(w);
    w.clock.advance(5_000); // time passes between reads
    expect(w.store.getPair(w.pairId)!.deadlineAt).toBe(before);
    expect(w.store.getPair(w.pairId)!.deadlineAt).toBe(before);
  });

  it('a process restart (a real file store, closed and reopened) does not reset it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ffm-deadline-'));
    const dbPath = path.join(dir, 'engine.sqlite');
    const clock = new VirtualClock();
    const venue = new FakeVenue();

    const pair: PairRow = {
      id: 'p1',
      mode: 'OPENING',
      a: legSpec(A_CONTRACT, 'BUY'),
      b: legSpec(B_CONTRACT, 'SELL'),
      targetQty: '0.152',
      limitPrice: '2500',
      pricePolicy: POLICY,
      deadlineAt: clock.now() + FOUR_LEG_WINDOW_MS,
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
      createdAt: clock.now(),
    };

    // Process 1: create the deal, place the maker, take a partial fill, restart.
    const first = new Store(dbPath);
    first.createPair(pair);
    const deps1: LoopDeps = { store: first, venue, clock };
    await tickPair(deps1, 'p1');
    const deadlineBefore = first.getPair('p1')!.deadlineAt;
    venue.fill(venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    clock.advance(1_000);
    await tickPair(deps1, 'p1'); // observe the fill
    expect(first.getPair('p1')!.deadlineAt).toBe(deadlineBefore);
    first.close(); // process exits

    // Process 2: reopen the SAME file. The deadline is read back, not rederived.
    const second = new Store(dbPath);
    expect(second.getPair('p1')!.deadlineAt).toBe(deadlineBefore);
    const deps2: LoopDeps = { store: second, venue, clock };
    clock.advance(FOUR_LEG_WINDOW_MS + 1_000); // well past the original deadline
    await tickPair(deps2, 'p1');
    expect(second.getPair('p1')!.mode).toBe('CONVERTING'); // still the SAME deadline
    second.close();
  });
});

/**
 * Expiry outranks automatic quoting, but the existing explicit controls keep
 * their original priority. Only the two interactions the ticket names are
 * asserted; the broader priority lattice is the existing suite's.
 */
describe('deadline priority', () => {
  it('expiry and a reprice condition in the SAME tick: expiry wins (the re-price is never placed)', async () => {
    // A 'touch' pair with a stale maker price: every OPENING tick also wants a
    // re-peg. Cross the deadline and one tick later it must have CONVERTED —
    // no cancel-then-replace, no new maker at the fresh touch.
    const w = mkWorld({ pricePolicy: 'touch', deadlineInMs: 1_000 });
    await stepChecked(w); // place the maker (limitPrice 2500, book touch 2500)
    const first = w.venue.liveOrder(A_CONTRACT)!;
    const deadline = deadlineOf(w)!;

    w.clock.advance(60_000); // past deadlineAt, and the book moved
    await stepChecked(w, 1);

    expect(w.store.getPair(w.pairId)!.mode).toBe('CONVERTING');
    expect(deadlineOf(w)).toBe(deadline);
    // The OPENING-tick re-peg is not reached: the live maker is the ORIGINAL.
    const live = w.venue.liveOrder(A_CONTRACT);
    expect(live?.clientText).toBe(first.clientText);
  });

  it('a manual stop already in effect stays STOPPING across the deadline — it is never converted', async () => {
    const w = mkWorld({ pricePolicy: POLICY, deadlineInMs: FOUR_LEG_WINDOW_MS });
    await stepChecked(w); // maker placed
    const deadline = deadlineOf(w)!;

    commands.stop(w.store, w.pairId); // the user said STOP while still OPENING
    w.clock.advance(FOUR_LEG_WINDOW_MS + 60_000); // …then the deadline passes
    await stepChecked(w, 8);

    const pair = w.store.getPair(w.pairId)!;
    // The STOP path cancels the maker and finishes honestly — it never
    // resurrects the maker window by converting to taker.
    expect(pair.mode).toBe('DONE');
    expect(pair.reportJson).not.toBeNull();
    expect(deadlineOf(w)).toBe(deadline); // and the deadline never moved
  });
});

describe('the window is a wait, not a fill guarantee', () => {
  it('a full maker fill finishes DONE immediately — it does not wait out the thirty minutes', async () => {
    const w = mkWorld({ pricePolicy: POLICY, deadlineInMs: FOUR_LEG_WINDOW_MS });
    await stepChecked(w); // place the maker
    const maker = w.venue.liveOrder(A_CONTRACT)!;

    w.venue.fill(maker.clientText, '0.152'); // the FULL target fills
    // Ticks advance only TICK_MS; the deadline is 30 minutes away.
    await stepChecked(w, 4);

    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(w.clock.t).toBeLessThan(pair.deadlineAt!); // finished BEFORE the window
    expect(fxStr(w.venue.truth().bTrue)).toBe('0.152'); // hedged, not converted
  });
});
