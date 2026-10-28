/**
 * the reconcile loop: OBSERVE (resolve in-doubt orders, re-read open ones) →
 * PROJECT (pure folds) → DECIDE (pure) → ACT (at most ONE wire mutation).
 *
 * Recovery IS this loop: the first tick after a crash is indistinguishable from
 * any other tick, because no decision depends on witnessing an event — only on
 * committed durable state plus current venue state. There is deliberately no
 * recovery module, no adopt-window, no repeg protocol.
 */
import { forgetHedgeWait, reportHedgeWait } from './hedge-wait';
import { fx, fxStr } from './fx';
import { type EngineObservation, type ObservationContext, observeCall, recordObservation } from './observation';
import { POC_REASON, decide, decideBeforeMakerPrices, project, sizeFor, type DecideCtx } from './decide';
import type { Store } from './db';
import {
  TUNING,
  type Action,
  type Clock,
  type OrderRow,
  type OrderSnapshot,
  type PairRow,
  type VenuePort,
} from './types';

export interface LoopDeps {
  /** Independent, default-off dependency optimization; rollout remains gated. */
  skipUnrelatedMakerWait?: boolean;
  /** Diagnostic clock only; production defaults to performance.now(). */
  waitMonotonicNow?: () => number;
  observation?: EngineObservation;
  evidence?: ObservationContext;
  store: Store;
  venue: VenuePort;
  clock: Clock;
  /** Optional overrides (tests); defaults from TUNING. */
  tuning?: Partial<typeof TUNING>;
  /** Simulation hook: when it returns true, the tick aborts right after the
   * write-ahead PENDING commit and before the wire call — the crash-between-
   * commit-and-send window. (Crash after send is simulated by the venue's
   * 'unknown' outcomes; the loop itself keeps no in-memory state, so any other
   * crash point is just "a fresh tick".) Reprice cancels use this hook after
   * wire initiation and their atomic provenance/quota commit, before consuming
   * the outcome. */
  crashAfterCommit?: () => boolean;
  onFinish?: (pairId: string) => void;
}

// Open-world status decoder: known strings map; anything else is quarantined,
// never guessed terminal or non-terminal (hazard 11).
// Live-verified CrossEx states (2026-07-23 smoke): OPEN, CANCELLED, REJECT —
// note "REJECT" without the -ED (a would-cross POC lands in state REJECT).
// Same shortening applies to FAIL: CrossEx returned state "FAIL" with label
// NOT_BEST_ACCOUNT_ROUTER (live, 2026-07-31) and the anchored FAILED alone did
// not match, so a dead order quarantined and froze its pair. closeReasonOf has
// always matched /REJECT|FAIL/ — the two halves must agree.
const OPENISH = /^(NEW|OPEN|LIVE|PENDING|ACTIVE|CREATED|ACCEPTED|PARTIAL(LY)?[-_ ]?FILL(ED)?)$/i;
const CLOSEDISH = /^(FILLED|FINISHED|CLOSED|DONE|CANCELL?ED|EXPIRED|REJECT(ED)?|FAIL(ED)?|IOC_?CANCELL?ED)$/i;

export function decodeStatus(raw: string): 'open' | 'closed' | 'unknown' {
  const s = raw.trim();
  if (CLOSEDISH.test(s)) return 'closed';
  if (OPENISH.test(s)) return 'open';
  return 'unknown';
}

/** Terminal close reason encoding. POC insta-cancels become 'poc-reject' so the
 * STOP detector (closeReason === 'cancelled' && !cancelRequested) can never
 * mistake them for a user cancel. The POC check runs FIRST: CrossEx surfaces a
 * would-cross POC as state=REJECT with reason "label: ORDER_POC_IMMEDIATE, …"
 * (live-verified 2026-07-23) — it must take the requote path with the poc
 * budget/backoff, never read as a generic rejection. */
function closeReasonOf(snapshot: OrderSnapshot): string {
  const s = snapshot.rawStatus.trim();
  if (POC_REASON.test(snapshot.reason)) return 'poc-reject';
  if (/REJECT|FAIL/i.test(s)) return `rejected:${snapshot.reason || s}`;
  if (/^FILLED$/i.test(s)) return 'filled';
  if (/CANCELL?ED|EXPIRED|IOC/i.test(s)) return 'cancelled';
  return 'filled'; // FINISHED/CLOSED/DONE with no adverse reason
}

function tuning(deps: LoopDeps): typeof TUNING {
  return { ...TUNING, ...deps.tuning };
}

/**
 * Fold a venue snapshot into an order row: monotone cum merge (a shrink is
 * corruption → alert + quarantine), open-world status decode, terminal encode.
 */
function applySnapshot(deps: LoopDeps, pair: PairRow, o: OrderRow, snap: OrderSnapshot): void {
  const now = deps.clock.now();
  const patch: Parameters<Store['updateOrder']>[3] = {};
  if (snap.venueOrderId && snap.venueOrderId !== o.venueOrderId) {
    patch.venueOrderId = snap.venueOrderId; // persist the numeric id the INSTANT we see it
  }
  // A venue string our exact-decimal parser cannot read is venue weirdness, not
  // a crash: quarantine (freeze) instead of throwing the whole tick away.
  let newCum: ReturnType<typeof fx>;
  try {
    newCum = fx(snap.cumQty || '0');
  } catch {
    deps.store.updateOrder(o.pairId, o.leg, o.seq, {
      ...patch,
      quarantinedStatus: `unparseable-cum:${snap.cumQty}`,
    });
    deps.store.alert(
      'error',
      pair.id,
      `venue reported an unparseable fill quantity on ${o.clientId} — quarantined`,
      now,
    );
    return;
  }
  const oldCum = fx(o.cumQty);
  if (newCum < oldCum) {
    deps.store.alert(
      'error',
      pair.id,
      `venue reported SHRINKING fill on ${o.clientId} (${o.cumQty} -> ${snap.cumQty}) — quarantined`,
      now,
    );
    patch.quarantinedStatus = `cum-shrink:${snap.rawStatus}`;
    deps.store.updateOrder(o.pairId, o.leg, o.seq, patch);
    return;
  }
  if (newCum > oldCum) patch.cumQty = fxStr(newCum);
  // Persist the venue's average execution price whenever it reports one (it only
  // grows meaningful as fills land) — this is the realized fill price the deal
  // report reads at finish, and the ONLY price a market/IOC hedge exposes.
  if (snap.avgFillPrice && snap.avgFillPrice !== '0' && snap.avgFillPrice !== o.avgFillPrice) {
    patch.avgFillPrice = snap.avgFillPrice;
  }

  // Keep the venue's own explanation for the UI: a status alone ("FAIL") tells
  // the user nothing, while the reason ("all trading channels are currently
  // busy…") tells them whether to retry, resize, or switch venue.
  if (snap.reason && snap.reason !== o.venueReason) patch.venueReason = snap.reason;

  const decoded = decodeStatus(snap.rawStatus);
  if (decoded === 'unknown') {
    patch.quarantinedStatus = snap.rawStatus;
    deps.store.alert(
      'warn',
      pair.id,
      `unclassifiable venue status "${snap.rawStatus}" on ${o.clientId} — frozen until it resolves${snap.reason ? ` (venue said: ${snap.reason})` : ''}`,
      now,
    );
  } else {
    if (o.quarantinedStatus) patch.quarantinedStatus = null; // resolved — unfreeze
    if (decoded === 'open' && o.state === 'PENDING') patch.state = 'OPEN';
    if (decoded === 'closed' && o.state !== 'CLOSED') {
      patch.state = 'CLOSED';
      patch.closeReason = closeReasonOf(snap);
      patch.resolvedAt = now;
    }
  }
  deps.store.updateOrder(o.pairId, o.leg, o.seq, patch);
  if (newCum > oldCum) recordObservation(deps.evidence, 'fill-confirmed', { leg: o.leg, client: o.clientId,
    order: snap.venueOrderId, fill: `${o.clientId}:${fxStr(newCum)}`, contract: o.leg === 'A' ? pair.a.contract : pair.b?.contract,
    quantity: fxStr(newCum - oldCum), cumulative: fxStr(newCum) });

  // Terminal side effects on the PAIR (backoffs/streaks) — committed levels.
  if (patch.state === 'CLOSED') {
    const reason = patch.closeReason!;
    if (o.leg === 'A') {
      const executed = fx(patch.cumQty ?? o.cumQty);
      if (executed > 0n) {
        // Any A-leg progress clears the failure budgets (a long clip series with
        // occasional whiffs must not accumulate into a spurious stop), and the
        // post-only streak with it — both count CONSECUTIVE zero-progress tries.
        // Each column resets independently, so a non-'best' deal's write is
        // exactly the single-column update it always was.
        if (pair.pocRejects > 0) deps.store.updatePair(pair.id, { pocRejects: 0 });
        if (pair.postOnlyRejects > 0) deps.store.updatePair(pair.id, { postOnlyRejects: 0 });
      } else if (isPostOnlyReject(o, reason) && pair.pricePolicy === 'best') {
        // A would-cross post-only rejection of the automatic quote. For a 'best'
        // deal this is an expected book-jitter event, so it draws its OWN budget
        // and never touches pocRejects — one jitter must not stop the deal
        // honestly and cut off the taker completion the user is owed. Every
        // other zero-progress terminal below still stops honestly.
        bumpPostOnlyWall(deps, pair, now);
      } else if (reason === 'poc-reject' || o.kind === 'taker') {
        // Zero-progress A-leg terminal for a NON-'best' deal — or, for a 'best'
        // deal, a taker clip that whiffed/was rejected post-acceptance. All draw
        // from ONE budget — without it a banded clip on a wide spread spins one
        // new venue order per tick forever, and a REDUCE_ONLY reject (position
        // vanished) never terminates the deal.
        bumpClipWall(deps, pair, now);
      }
    }
    if (o.leg === 'B') {
      const executed = fx(patch.cumQty ?? o.cumQty);
      if (executed > 0n) {
        // A hedge that filled ANYTHING clears the wall streak.
        if (pair.hedgeRejectStreak > 0) deps.store.updatePair(pair.id, { hedgeRejectStreak: 0 });
      } else {
        // Zero-fill hedge terminal — a definitive reject OR an IOC whiff. Both
        // count toward the wall: a persistently-empty book is as much a wall as
        // a margin reject, and without a backoff a whiff retries every tick
        // forever while the maker keeps acquiring (hazard 7).
        bumpHedgeWall(deps, pair, now);
      }
    }
  }
}

/** True when a leg-A terminal was a post-only (would-cross) rejection — the
 * venue ACCEPTED then instantly killed the order because its price crossed the
 * book. The loop encodes that shape as `reason === 'poc-reject'` (see
 * `closeReasonOf`); a definitively REJECTED create carries the venue's own
 * label instead, so callers match that label against `POC_REASON` themselves. */
function isPostOnlyReject(o: OrderRow, reason: string): boolean {
  return o.kind === 'maker' && reason === 'poc-reject';
}

/** Count a zero-progress A-leg attempt toward the failure budget — the OLD
 * shared budget (`pocRejects`, cap `MAX_POC_REJECTS`) for everything that means
 * "we could not eat the remainder", with backoff + a standing alert at the cap
 * (decide() then stops the deal honestly instead of retrying forever).
 *
 * `'best'` post-only rejects do NOT come here: quoting at the same-side best
 * makes a would-cross reject an expected book-jitter event, and it draws the
 * SEPARATE `postOnlyRejects` budget instead (see `bumpPostOnlyWall`), whose
 * destination is CONVERTING. Keeping them off `pocRejects` is what makes the
 * conversion path survive a jittery book. */
function bumpClipWall(deps: LoopDeps, pair: PairRow, now: number): void {
  const n = pair.pocRejects + 1;
  deps.store.updatePair(pair.id, {
    pocRejects: n,
    makerNotBefore: now + tuning(deps).POC_BACKOFF_MS,
  });
  if (n >= tuning(deps).MAX_POC_REJECTS) {
    deps.store.alert(
      'error',
      pair.id,
      'A-leg wall: repeated order failures (rejects/whiffs) — the deal is stopping with whatever filled',
      now,
    );
  }
}

/** Count ONE post-only (would-cross) rejection of an automatic `'best'` quote
 * toward its OWN budget: same backoff as a clip wall, a loud standing alert at
 * the cap, and — unlike `bumpClipWall` — it does NOT touch `pocRejects`.
 * decide() converts to taker once the budget is spent, so the alert is worded
 * for "completing the remainder at market", not "giving up". */
function bumpPostOnlyWall(deps: LoopDeps, pair: PairRow, now: number): void {
  const n = pair.postOnlyRejects + 1;
  deps.store.updatePair(pair.id, {
    postOnlyRejects: n,
    makerNotBefore: now + tuning(deps).POC_BACKOFF_MS,
  });
  if (n >= tuning(deps).MAX_POST_ONLY_REJECTS) {
    deps.store.alert(
      'warn',
      pair.id,
      'post-only wall: the venue kept refusing the maker quote as would-cross — completing the remainder at market',
      now,
    );
  }
}

/** Count a failed hedge attempt toward the wall: streak + backoff, and a loud
 * standing alert once the streak crosses the halt threshold (visible even in
 * STOPPING, which the wall no longer re-halts). */
function bumpHedgeWall(deps: LoopDeps, pair: PairRow, now: number): void {
  const streak = pair.hedgeRejectStreak + 1;
  deps.store.updatePair(pair.id, {
    hedgeRejectStreak: streak,
    hedgeNotBefore: now + tuning(deps).HEDGE_BACKOFF_MS,
  });
  if (streak >= tuning(deps).HEDGE_REJECT_HALT) {
    deps.store.alert(
      'error',
      pair.id,
      'hedge wall: repeated hedge attempts are failing — exposure is not being neutralized',
      now,
    );
  }
}

/**
 * Resolution ladder for an in-doubt (PENDING) order — hazards 1, 2, 5:
 * probe by id, never resend; a failed read resolves nothing; declare-dead only
 * after the ambiguity window AND a provably-covering listing sweep.
 */
async function resolvePending(deps: LoopDeps, pair: PairRow, o: OrderRow): Promise<void> {
  const now = deps.clock.now();
  const read = await observeCall(deps.evidence, 'order-read', { leg: o.leg, client: o.clientId, order: o.venueOrderId }, () => deps.venue.getOrder({
    venueOrderId: o.venueOrderId ?? undefined,
    clientText: o.clientId,
  }, deps.evidence));
  if (read.kind === 'error') {
    // Same escalation as observeOpen: a PENDING order may be live and filling.
    const streak = o.readFailStreak + 1;
    deps.store.updateOrder(o.pairId, o.leg, o.seq, { readFailStreak: streak });
    if (streak === tuning(deps).READ_FAIL_ALERT) {
      deps.store.alert(
        'error',
        pair.id,
        `cannot read pending order ${o.clientId} from the venue (${streak} consecutive failures: ${read.message}) — it may be live and filling; check credentials and connectivity`,
        now,
      );
    }
    return; // stays PENDING; next tick retries
  }
  if (o.readFailStreak > 0) {
    deps.store.updateOrder(o.pairId, o.leg, o.seq, { readFailStreak: 0 }); // reachable again
  }
  if (read.kind === 'found') {
    applySnapshot(deps, pair, o, read.snapshot);
    return;
  }
  // Authoritative not-found.
  if (now - o.createdAt < tuning(deps).AMBIGUITY_MS) return; // create may still be in flight
  const contract = o.leg === 'A' ? pair.a.contract : pair.b?.contract;
  if (!contract) return; // defensive: a B order cannot exist on a single-leg deal
  // Generous from-bound (10 min before our local creation time): the sweep is
  // symbol-filtered and paginated so the cost is trivial, and a tight bound
  // would let local-vs-venue clock skew exclude the order from its own sweep —
  // a false DEAD verdict is an I1 violation, the one thing we never risk.
  const sweep = await observeCall(deps.evidence, 'history-sweep', { leg: o.leg, client: o.clientId, contract },
    () => deps.venue.sweepForOrder(contract, o.clientId, o.createdAt - 600_000, deps.evidence));
  if (sweep.found) {
    applySnapshot(deps, pair, o, sweep.found);
    return;
  }
  if (sweep.covered) {
    // Proven never to have reached the venue: release the reservation. Clears
    // any quarantine — a DEAD verdict supersedes it (else the row would be
    // re-observed forever and the pair frozen with no way out).
    deps.store.updateOrder(o.pairId, o.leg, o.seq, {
      state: 'DEAD',
      closeReason: 'never-reached-venue',
      quarantinedStatus: null,
      resolvedAt: now,
    });
    return;
  }
  deps.store.alert(
    'warn',
    pair.id,
    `order ${o.clientId} unresolved: venue listings could not prove absence — pair stays frozen`,
    now,
  );
}

/** Re-read an OPEN order (fills accrue; cancels land; statuses change). */
async function observeOpen(deps: LoopDeps, pair: PairRow, o: OrderRow): Promise<void> {
  const read = await observeCall(deps.evidence, 'order-read', { leg: o.leg, client: o.clientId, order: o.venueOrderId }, () => deps.venue.getOrder({
    venueOrderId: o.venueOrderId ?? undefined,
    clientText: o.clientId,
  }, deps.evidence));
  if (read.kind === 'error') {
    // A failed read resolves NOTHING, and this order is live on the venue: it
    // keeps filling while our cum_qty freezes at its last good value. project()
    // then computes unhedged from stale numbers and the deal renders as healthy
    // and progressing. Silently returning made a revoked key, a venue outage or
    // a dead link invisible for as long as it lasted.
    //
    // Count the streak and escalate ONCE at the threshold (the alert store
    // de-dupes against unacked rows, so this does not nag every tick).
    const streak = o.readFailStreak + 1;
    deps.store.updateOrder(o.pairId, o.leg, o.seq, { readFailStreak: streak });
    if (streak === tuning(deps).READ_FAIL_ALERT) {
      deps.store.alert(
        'error',
        pair.id,
        `cannot read live order ${o.clientId} from the venue (${streak} consecutive failures: ${read.message}) — its fills are NOT being tracked; check credentials and connectivity`,
        deps.clock.now(),
      );
    }
    return; // still OPEN; next tick retries
  }
  if (o.readFailStreak > 0) {
    deps.store.updateOrder(o.pairId, o.leg, o.seq, { readFailStreak: 0 }); // reachable again
  }
  if (read.kind === 'found') {
    applySnapshot(deps, pair, o, read.snapshot);
    return;
  }
  // An OPEN order authoritatively not found is abnormal (venue purge?) — freeze + alert.
  deps.store.updateOrder(o.pairId, o.leg, o.seq, { quarantinedStatus: 'open-but-not-found' });
  deps.store.alert(
    'error',
    pair.id,
    `open order ${o.clientId} not found on the venue — quarantined for operator review`,
    deps.clock.now(),
  );
}

/** The write-ahead submission protocol: reservation commits BEFORE the wire call. */
async function performPlace(
  deps: LoopDeps,
  pair: PairRow,
  a: Extract<Action, { type: 'place' }>,
): Promise<void> {
  const now = deps.clock.now();
  const leg = a.leg === 'A' ? pair.a : pair.b;
  if (!leg) return; // defensive: decide never places on B for a single-leg deal
  const o = deps.store.insertPendingOrder({
    pairId: pair.id,
    leg: a.leg,
    kind: a.kind,
    side: leg.side,
    qty: a.qty,
    price: a.price ?? null,
    tif: a.tif,
    now,
  });
  recordObservation(deps.evidence, 'registered', { leg: o.leg, client: o.clientId, contract: leg.contract,
    quantity: o.qty, cumulative: o.cumQty });
  // Maker placements update the price intent: "maker price ≠ intent" is exactly
  // the re-peg trigger, so the intent must track what we actually placed. The
  // PLACEMENT TIME is recorded here too — it is the clock the 15 s reprice
  // interval is measured from (a distinct fact from `makerNotBefore`, the old
  // reject backoff). Committed write-ahead with the reservation, before the
  // wire call: a crash before the send still consumed the interval.
  if (a.kind === 'maker' && a.price !== undefined) {
    deps.store.updatePair(pair.id, {
      limitPrice: a.price,
      ...(pair.autoPricePolicy === 'best' ? { lastMakerPlacementAt: now } : {}),
    });
    recordObservation(deps.evidence, 'intent-changed', { mode: pair.mode, policy: pair.pricePolicy, price: a.price });
  }
  if (deps.crashAfterCommit?.()) return; // simulated crash between commit and wire

  const out = await observeCall(deps.evidence, 'create', { leg: o.leg, client: o.clientId, contract: leg.contract, quantity: a.qty }, () => deps.venue.create({
    contract: leg.contract,
    side: leg.side,
    qty: a.qty,
    price: a.price,
    tif: a.tif,
    reduceOnly: leg.reduceOnly,
    clientText: o.clientId,
  }, deps.evidence));
  if (out.kind === 'ok') {
    // Streak resets happen in applySnapshot only when a hedge actually FILLED
    // something — a submit-ok that whiffs must still count toward the wall.
    applySnapshot(deps, pair, o, out.snapshot);
    return;
  }
  if (out.kind === 'reject') {
    // Definite (allowlisted) venue business rejection — release the reservation.
    deps.store.updateOrder(o.pairId, o.leg, o.seq, {
      state: 'DEAD',
      closeReason: `rejected:${out.label}`,
      resolvedAt: deps.clock.now(),
    });
    if (a.leg === 'A') {
      // A create-time would-cross post-only reject on a 'best' quote is the
      // SAME book-jitter event as the observed insta-cancel above — it must draw
      // the separate post-only budget, or a jittery book would exhaust the old
      // budget in 5 tries and stop the deal honestly instead of converting.
      if (a.kind === 'maker' && pair.pricePolicy === 'best' && POC_REASON.test(out.label)) {
        bumpPostOnlyWall(deps, pair, deps.clock.now());
      } else {
        // Every OTHER definitive A-leg create rejection draws the SAME failure
        // budget — POC would-cross on a non-'best' deal, REDUCE_ONLY (position
        // vanished), margin/size walls on clips. decide() stops the deal
        // honestly when it runs out.
        bumpClipWall(deps, pair, deps.clock.now());
      }
    } else {
      bumpHedgeWall(deps, pair, deps.clock.now());
    }
    return;
  }
  // UNKNOWN: stays PENDING — the freeze rule blocks all new placement on this
  // pair until the resolution ladder settles it. Nothing is journaled terminal.
}

async function performCancel(deps: LoopDeps, pair: PairRow, o: OrderRow, reprice = false): Promise<void> {
  const ref = { venueOrderId: o.venueOrderId ?? undefined, clientText: o.clientId };
  let request: ReturnType<VenuePort['cancel']>;
  if (reprice && !o.cancelRequested) {
    // Initiate the wire request first, then commit BOTH facts before awaiting
    // its outcome. There is no pre-send quota charge and no partial DB commit.
    // A crash before this commit leaves no provenance: observation stops the
    // deal honestly if the venue canceled, rather than replacing it uncounted.
    request = observeCall(deps.evidence, 'cancel', { leg: o.leg, client: o.clientId, order: o.venueOrderId }, () => deps.venue.cancel(ref, deps.evidence));
    // A failed DB commit or simulated crash can abandon this outcome.
    void request.catch(() => undefined);
    deps.store.recordRepriceCancel(o);
    if (deps.crashAfterCommit?.()) return;
  } else {
    deps.store.updateOrder(o.pairId, o.leg, o.seq, { cancelRequested: 1 });
    if (deps.crashAfterCommit?.()) return;
    request = observeCall(deps.evidence, 'cancel', { leg: o.leg, client: o.clientId, order: o.venueOrderId }, () => deps.venue.cancel(ref, deps.evidence));
  }
  // Cancel needs no state machine: "not found / already finished" is success
  // (no further fills can land), an unknown outcome is irrelevant — the loop
  // keeps observing the order until the venue reports a terminal cum.
  const outcome = await request;

  // THE WAY OUT OF A QUARANTINE. An unclassifiable status freezes the pair, and
  // quarantine only clears when a LATER read returns a status we know — which a
  // venue that already answered with an unknown string will never do. So the
  // deal sits frozen forever and Stop cannot finish it.
  //
  // A cancel answering 'ok' is the proof that breaks the deadlock: it means
  // canceled, or already terminal/not found, i.e. NO FURTHER FILLS CAN LAND.
  // Take one more read first so we close on the freshest cum the venue will
  // give us (finalizing on a stale cum would under-count fills and leave the
  // hedge short), then close the order out and let the pair settle honestly.
  // ONLY when the user asked to get out. During OPENING the engine cancels a
  // resting maker precisely BECAUSE something is quarantined (protecting the
  // unhedged side); force-resolving there would destroy the freeze the cancel
  // exists to honour, and let the deal keep trading on a status we cannot read.
  if (pair.mode !== 'STOPPING' && pair.mode !== 'HALTED') return;
  if (outcome.kind !== 'ok' || !o.quarantinedStatus) return;
  const read = await observeCall(deps.evidence, 'order-read', { leg: o.leg, client: o.clientId, order: o.venueOrderId }, () => deps.venue.getOrder({
    venueOrderId: o.venueOrderId ?? undefined,
    clientText: o.clientId,
  }, deps.evidence));
  if (read.kind === 'found') applySnapshot(deps, pair, o, read.snapshot);
  const fresh = deps.store.listOrders(o.pairId).find((x) => x.leg === o.leg && x.seq === o.seq) ?? o;
  if (fresh.state === 'CLOSED' || !fresh.quarantinedStatus) return; // it resolved itself
  deps.store.updateOrder(o.pairId, o.leg, o.seq, {
    state: 'CLOSED',
    // NOT 'cancelled': that spelling means "the user killed it on the venue"
    // and would be decoded as an explicit STOP (decide.ts).
    closeReason: `force-resolved:${fresh.quarantinedStatus}`,
    quarantinedStatus: null,
    resolvedAt: deps.clock.now(),
  });
  deps.store.alert(
    'warn',
    pair.id,
    `${o.clientId} stayed unclassifiable ("${fresh.quarantinedStatus}"), but the venue confirmed the cancel — closing it out at ${fresh.cumQty} filled so the deal can settle`,
    deps.clock.now(),
  );
}

async function perform(deps: LoopDeps, pair: PairRow, action: Action): Promise<void> {
  switch (action.type) {
    case 'idle':
      return;
    case 'setMode':
      deps.store.updatePair(pair.id, {
        mode: action.mode,
        ...(action.haltReason ? { haltReason: action.haltReason } : {}),
      });
      recordObservation(deps.evidence, 'intent-changed', { mode: action.mode });
      if (action.mode === 'HALTED') deps.onFinish?.(pair.id);
      return;
    case 'cancel':
      return performCancel(deps, pair, action.order, action.reprice);
    case 'place':
      return performPlace(deps, pair, action);
    case 'finish': {
      // decide.report() is pure (no store access); enrich it here with the
      // quantity-weighted average fill price per leg from the recorded fills so
      // the deal report can show taker-avg-vs-limit slippage.
      const report = {
        ...action.report,
        aAvgFill: deps.store.avgFillPrice(pair.id, 'A'),
        bAvgFill: deps.store.avgFillPrice(pair.id, 'B'),
      };
      deps.store.updatePair(pair.id, { mode: 'DONE', reportJson: JSON.stringify(report) });
      recordObservation(deps.evidence, 'intent-changed', { mode: 'DONE' });

      // A deal can legitimately finish holding exposure the hedge venue will not
      // accept - below its lot is a true rounding remainder, and [R1] settled
      // that finishing (named) beats idling forever in that dead zone. But the
      // same terminal covers a residual blocked by minSize/minNotional, which is
      // a WHOLE number of lots and can be most of the deal: stop a pair early
      // with 0.999 filled against a hedge leg whose minimum is 1.0 and the user
      // is 99.9% naked. That must not be discoverable only by reading
      // report_json - raise it where the operator actually looks.
      if (pair.b) {
        const left = fx(report.unhedged);
        if (left >= fx(pair.b.lot)) {
          deps.store.alert(
            'error',
            pair.id,
            `deal finished with ${report.unhedged} UNHEDGED on ${pair.b.contract} — below that venue's minimum order size/notional, so the engine could not neutralize it. You are holding a one-sided position.`,
            deps.clock.now(),
          );
        }
      }
      deps.onFinish?.(pair.id);
      return;
    }
  }
}

/** One tick for one pair. At most ONE wire mutation leaves this function.
 * Whatever the tick observed — even if it then threw — is booked into the
 * strategy slice ledger afterwards: database only, no wire (engine/slices.ts). */
export async function tickPair(deps: LoopDeps, pairId: string): Promise<Action> {
  try {
    return await (deps.observation ? deps.observation.tickPair(pairId, evidence => tickPairCore({ ...deps, evidence }, pairId)) : tickPairCore(deps, pairId));
  } finally {
    try {
      deps.store.slices.bookFills(pairId, deps.clock.now());
    } catch (err) {
      deps.store.alert('error', pairId, `slice booking failed: ${(err as Error).message}`, deps.clock.now());
    }
  }
}

function changedPriceIntent(deps: LoopDeps, pair: PairRow): Action | null {
  const intent = deps.store.getPair(pair.id) ?? pair;
  if (intent.mode === pair.mode && intent.limitPrice === pair.limitPrice &&
      intent.pricePolicy === pair.pricePolicy && intent.autoPricePolicy === pair.autoPricePolicy) return null;
  recordObservation(deps.evidence, 'intent-changed', { mode: intent.mode, policy: intent.pricePolicy, price: intent.limitPrice });
  recordObservation(deps.evidence, 'decision', { action: 'idle', reason: 'intent changed mid-tick', operation: 'intent-changed' });
  return { type: 'idle', reason: 'intent changed mid-tick — deferring to a fresh tick' };
}

async function tickPairCore(deps: LoopDeps, pairId: string): Promise<Action> {
  const pair0 = deps.store.getPair(pairId);
  if (!pair0 || pair0.mode === 'DONE') {
    forgetHedgeWait(deps.store, pairId);
    return { type: 'idle', reason: 'done' };
  }

  recordObservation(deps.evidence, 'intent', { mode: pair0.mode, policy: pair0.pricePolicy, price: pair0.limitPrice });
  // ---- OBSERVE ----
  for (const o of deps.store.listOrders(pairId)) {
    const pair = deps.store.getPair(pairId)!;
    if (o.state === 'PENDING') await resolvePending(deps, pair, o);
    else if (o.state === 'OPEN' || (o.quarantinedStatus && o.state !== 'DEAD')) {
      await observeOpen(deps, pair, o); // DEAD rows are proven absent — nothing to observe
    }
  }

  // ---- PROJECT + DECIDE (pure) ----
  let pair = deps.store.getPair(pairId)!;
  let orders = deps.store.listOrders(pairId);
  let proj = project(pair, orders);
  const optimized = deps.skipUnrelatedMakerWait === true;
  const readRefB = () => observeCall(deps.evidence, 'refPrice', { leg: 'B', contract: pair.b!.contract },
    () => deps.venue.refPrice(pair.b!.contract, pair.autoPricePolicy === 'best', deps.evidence));
  let earlyRefB: string | null | undefined;
  if (optimized && !proj.anyPending && !proj.anyQuarantined && pair.b &&
      fx(proj.unhedged) > 0n && fx(pair.b.minNotional) > 0n) {
    earlyRefB = await readRefB();
    const changed = changedPriceIntent(deps, pair);
    if (changed) return changed;
    // Adapter-valid, positive reference only. Never use the unused-price sentinel.
    if (earlyRefB !== null && fx(earlyRefB) <= 0n) earlyRefB = null;
    if (earlyRefB !== null) {
      // Reconfirm after the price await, independently of reporting state.
      // New fills/cancel races and unknown reads must affect this tick's projection.
      for (const order of deps.store.listOrders(pairId)) {
        const current = deps.store.getPair(pairId)!;
        if (order.state === 'PENDING') await resolvePending(deps, current, order);
        else if (order.state === 'OPEN' || (order.quarantinedStatus && order.state !== 'DEAD')) {
          await observeOpen(deps, current, order);
        }
      }
      const changedAfterRead = changedPriceIntent(deps, pair);
      if (changedAfterRead) return changedAfterRead;
      pair = deps.store.getPair(pairId)!;
      orders = deps.store.listOrders(pairId);
      proj = project(pair, orders);
    }
  }
  recordObservation(deps.evidence, 'projection', { aFilled: proj.aFilled, bFilled: proj.bFilled,
    aReserved: proj.aReserved, bReserved: proj.bReserved, unreserved: proj.unhedged,
    outcome: orders.some(o => o.readFailStreak > 0 || o.state === 'PENDING' || o.quarantinedStatus) ? 'unknown' : 'ok' });

  // Fetch venue prices ONLY when this tick's decision will actually use one —
  // these are slow public-API calls (esp. Hyperliquid), and a blanket fetch
  // every tick blocks the loop for seconds, defeating the fast re-tick and
  // dragging Stop/Convert. While frozen (an order in doubt) decide() only ever
  // cancels — which needs no price — so skip all fetches then.
  const frozen = proj.anyPending || proj.anyQuarantined;
  const needTouch =
    !frozen && pair.mode === 'OPENING' && pair.pricePolicy === 'touch' && proj.makerOrder?.state !== 'OPEN';
  // A 'best' deal needs the live same-side best on EVERY OPENING tick — not only
  // when it is about to place, but also to MEASURE the resting quote's lag
  // against the current book (the auto-reprice trigger). One extra cached book
  // read per tick while opening is the price of following a moving market.
  const needBest = !frozen && pair.mode === 'OPENING' && pair.pricePolicy === 'best';
  // A reference price is needed ONLY for a min-notional sizing check (taker legs
  // are plain MARKET, so no band pricing). Fetch it only when a leg with a
  // min-notional is actually about to submit.
  const hedgeOwed = !frozen && pair.b !== null && fx(proj.unhedged) > 0n;
  const needRefB = hedgeOwed && fx(pair.b!.minNotional) > 0n;
  // refA prices the min-notional check AND — when the deal carries a slippage
  // band (every close does) — the marketable-limit clip itself, so it must be
  // fetched in that case too or decide() can only defer.
  const needRefA =
    !frozen &&
    pair.mode === 'CONVERTING' &&
    fx(proj.residualA) > 0n &&
    (fx(pair.a.minNotional) > 0n || pair.clipBandBp !== null);

  const skipMaker = optimized && (needTouch || needBest || needRefA) && decideBeforeMakerPrices(pair, proj, deps.clock.now(), {
    touchA: null, bestA: null, bookOutageObservedAt: null,
    refB: earlyRefB === undefined ? '0' : earlyRefB, refA: '0',
    maxClip: pair.maxClip ?? tuning(deps).MAX_CLIP,
  }) !== null;
  const fetchTouch = needTouch && !skipMaker;
  const fetchBest = needBest && !skipMaker;
  const fetchRefA = needRefA && !skipMaker;

  // ---- book-outage pause (ticket 04) -------------------------------------
  // Sample the observable BEFORE the (possibly slow) book fetch: a book call
  // that HANGS must not understate the outage's age. `bookOutageStartedAt` is a
  // persisted fact, so the 30 s grading survives a restart and can never be
  // reset by a tick that merely succeeds. It is cleared the instant a FRESH
  // valid book is observed, which is also exactly when a stale marker (one
  // older than the last successful placement) is discarded: recovering and
  // later failing again starts a NEW window, and the pause always grades from
  // the CURRENT outage.
  let outageObservedAt = fetchBest ? deps.clock.now() : null;
  // "The book endpoint is down" and "the whole venue is unreachable" are
  // DIFFERENT states, and only the first makes a cancel a safe action. A failed
  // ORDER read on any order means we cannot even confirm what the venue holds —
  // the cancel's own outcome would be unknown — so the observable is withdrawn
  // and decide() falls through to the existing freeze/quarantine rules instead
  // of emitting a cancel. (An unconfirmed cancel is never guessed or resent.)
  if (orders.some((o) => o.readFailStreak > 0)) outageObservedAt = null;
  const carriedStart =
    pair.bookOutageStartedAt > 0 && pair.bookOutageStartedAt >= pair.lastMakerPlacementAt
      ? pair.bookOutageStartedAt
      : 0;
  const outageStart = !fetchBest ? (optimized ? pair.bookOutageStartedAt : 0)
    : carriedStart > 0 ? carriedStart : (outageObservedAt ?? deps.clock.now());
  if (outageStart !== pair.bookOutageStartedAt) {
    deps.store.updatePair(pairId, { bookOutageStartedAt: outageStart });
  }
  const ctx: DecideCtx = {
    touchA: fetchTouch ? await observeCall(deps.evidence, 'touch', { leg: 'A', contract: pair.a.contract }, () => deps.venue.touch(pair.a.contract, pair.a.side, pair.a.tick, deps.evidence)) : null,
    bestA: fetchBest ? await observeCall(deps.evidence, 'bestQuote', { leg: 'A', contract: pair.a.contract }, () => deps.venue.bestQuote(pair.a.contract, pair.a.side, pair.a.tick, deps.evidence)) : null,
    bookOutageObservedAt: outageObservedAt,
    // '0' (unused) when no hedge is owed; a real fetch only when one is.
    refB: needRefB ? (earlyRefB === undefined ? await readRefB() : earlyRefB) : '0',
    refA: fetchRefA ? await observeCall(deps.evidence, 'refPrice', { leg: 'A', contract: pair.a.contract }, () => deps.venue.refPrice(pair.a.contract, pair.autoPricePolicy === 'best', deps.evidence)) : '0',
    maxClip: pair.maxClip ?? tuning(deps).MAX_CLIP,
  };
  // Never mix pre-await prices with a Stop/Convert/quote-mode edit committed during IO.
  const changedAfterPrices = changedPriceIntent(deps, pair);
  if (changedAfterPrices) return changedAfterPrices;
  // The book answered with a valid two-sided top: the outage, if any, is OVER.
  // Every consumer of `ctx.bestA` treats a non-null value as a fresh valid book
  // (decide only ever reprices off one), so this is the correct recovery edge.
  const bookRecovered = fetchBest && ctx.bestA !== null;
  if (bookRecovered && outageStart !== 0) {
    deps.store.updatePair(pairId, { bookOutageStartedAt: 0 });
  }
  reportHedgeWait(deps, pair, proj, orders, needRefB ? ctx.refB : undefined);
  // A hedge that cannot be SIZED is a hedge wall like any other. refPrice()
  // returns null on any failure — unsupported venue, a wrong native symbol, a
  // venue outage, a book slower than the 2.5s timeout — and with a positive
  // min_notional (every CrossEx FUTURE symbol has one) sizeFor then answers
  // "cannot size safely". No B order is created, so no terminal is ever
  // observed, so bumpHedgeWall is never called from applySnapshot and
  // hedgeRejectStreak stays 0 forever: the HEDGE_REJECT_HALT transition was
  // unreachable and a naked deal could sit in an 'active' mode indefinitely
  // with no operator signal. Count it here instead.
  //
  // Gated on the residual being genuinely SUBMITTABLE, not merely positive:
  // sizeFor answers FX_ZERO for sub-lot/sub-minSize dust before ever consulting
  // the ref price, and dust is the steady state between fills whenever leg A's
  // lot is finer than leg B's. Such a residual is unhedgeable whatever the book
  // says, no B order is ever submitted for it, and the streak's only reset is a
  // B fill — so counting dust here would let isolated ref-price blips, even
  // hours apart, ratchet a healthy deal into a spurious HALT. Only when sizeFor
  // says "cannot size safely" (null: a whole number of lots blocked purely by
  // the missing ref) is the null ref a real hedge wall. Backoff-gated, so it
  // increments at most once per HEDGE_BACKOFF_MS rather than once per tick.
  if (
    needRefB &&
    ctx.refB === null &&
    sizeFor(fx(proj.unhedged), pair.b!, null) === null &&
    deps.clock.now() >= pair.hedgeNotBefore
  ) {
    bumpHedgeWall(deps, pair, deps.clock.now());
  }

  // Decide against the outage marker THIS tick established, not the pre-update
  // snapshot: `outageStart` is the committed start (or 0 on the recovery tick),
  // and decide() must grade the pause from exactly that.
  const pairForDecide: PairRow = { ...pair, bookOutageStartedAt: bookRecovered ? 0 : outageStart };
  const action = decide(pairForDecide, proj, deps.clock.now(), ctx);

  recordObservation(deps.evidence, 'decision', { action: action.type, reason: 'reason' in action ? action.reason : action.type,
    operation: proj.anyPending ? 'pending' : proj.anyQuarantined ? 'quarantine' : needRefB && ctx.refB === null
      ? 'hedge-price-unavailable' : needBest && ctx.bestA === null ? 'maker-price-unavailable' : 'decide' });
  // ---- ACT (≤ 1 wire mutation) ----
  await perform(deps, pair, action);
  if (deps.store.getPair(pairId)?.mode === 'DONE') forgetHedgeWait(deps.store, pairId);
  return action;
}

/** User commands: one-row intent edits — levels, not events. */
export const commands = {
  convertNow(store: Store, pairId: string): void {
    // OPENING only: a STOPPING pair may be a venue-cancel STOP whose semantics
    // are "relinquish — never resume acquisition" (design §8).
    const p = store.getPair(pairId);
    if (p && p.mode === 'OPENING') store.updatePair(pairId, { mode: 'CONVERTING' });
  },
  stop(store: Store, pairId: string): void {
    const p = store.getPair(pairId);
    if (p && p.mode !== 'DONE') store.updatePair(pairId, { mode: 'STOPPING' });
  },
  /**
   * Re-peg the maker remainder. `pricePolicy` must be set to match WHAT the
   * caller asked for, because decide() re-derives the placement price from it:
   * a 'touch' pair recomputes `ctx.touchA ?? limitPrice` on the next placement,
   * so writing a user's explicit price without pinning the policy means the live
   * touch silently wins and their price is thrown away.
   *   'fixed' — the user typed a price ("Re-peg to price"): honor it verbatim.
   *   'touch' — follow the book ("Re-peg to touch"): also restores tracking on a
   *             pair that a previous explicit re-peg had pinned.
   */
  repeg(store: Store, pairId: string, freshPrice: string, pricePolicy?: PairRow['pricePolicy']): void {
    const p = store.getPair(pairId);
    if (p && p.mode === 'OPENING') {
      store.updatePair(pairId, {
        limitPrice: freshPrice,
        ...(pricePolicy ? { pricePolicy } : {}),
      });
    }
  },
  resumeAfterHalt(store: Store, pairId: string): void {
    const p = store.getPair(pairId);
    if (p && p.mode === 'HALTED') {
      store.updatePair(pairId, { mode: 'STOPPING', hedgeRejectStreak: 0, hedgeNotBefore: 0 });
    }
  },
};

/** The production loop: a setTimeout CHAIN (never setInterval) — the next pass
 * is scheduled only after the current one fully completes, so overlap is
 * impossible by construction.
 *
 * Pacing is WORK-CONSERVING: a pass in which any pair ACTED (placed, canceled,
 * mode-edited — anything non-idle) schedules the next pass at FAST_TICK_MS, so
 * multi-step convergences (Stop = hedge → cancel → observe → finish) complete
 * in network time, not one step per second. Quiet passes fall back to TICK_MS.
 *
 * Returns { wake }: routes call it after a command/create so the loop reacts
 * immediately instead of waiting out the current sleep. Wake during a running
 * pass queues exactly one immediate follow-up pass (still never overlapping). */
export function startLoop(deps: LoopDeps, opts?: { signal?: AbortSignal }): { wake: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let wakeQueued = false;

  const run = async (): Promise<void> => {
    if (opts?.signal?.aborted) return;
    timer = null;
    running = true;
    let acted = false;
    // The loop's spine is fault-isolated end to end: a throw anywhere (listPairs
    // on a sick disk, a tick bug, even the alert insert itself) must never kill
    // the setTimeout chain — a silently-stopped reconciler with live orders on
    // the venue is the worst possible posture.
    try {
      for (const pair of deps.store.listPairs({ activeOnly: true })) {
        try {
          const action = await tickPair(deps, pair.id);
          if (action.type !== 'idle') acted = true;
        } catch (err) {
          // A handler throw is a code bug: surface loudly, keep other pairs alive.
          try {
            deps.store.alert('error', pair.id, `tick failed: ${(err as Error).message}`, deps.clock.now());
          } catch {
            console.error(`[engine] tick failed for ${pair.id} (alert write also failed)`, err);
          }
        }
      }
    } catch (err) {
      console.error('[engine] loop pass failed', err);
    } finally {
      running = false;
      const delay = wakeQueued ? 0 : acted ? tuning(deps).FAST_TICK_MS : tuning(deps).TICK_MS;
      wakeQueued = false;
      timer = setTimeout(run, delay);
    }
  };

  void run();
  return {
    wake: (): void => {
      if (opts?.signal?.aborted) return;
      if (running) {
        wakeQueued = true; // the in-flight pass reschedules immediately when it ends
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 0);
    },
  };
}
