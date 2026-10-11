/**
 * execution engine — shared contracts. THE execution engine of the app:
 * every trade (maker+hedge pair, both-market pair, single open, close) is a
 * DEAL — converge leg A to a target, keeping leg B (when present) hedged to
 * A's fills.
 *
 * Design (docs/MAKER-HEDGE.md): one SQLite file is the system of record (intent +
 * write-ahead order registry + observed facts); one single-writer reconcile
 * loop is the only code that mutates state or calls venue-mutating endpoints;
 * every derived quantity is a pure fold recomputed each tick.
 */

export type PairMode = 'OPENING' | 'CONVERTING' | 'STOPPING' | 'HALTED' | 'DONE';
export type OrderState = 'PENDING' | 'OPEN' | 'CLOSED' | 'DEAD';
export type Leg = 'A' | 'B';
export type Side = 'BUY' | 'SELL';

/** Venue trading rules for one leg, snapshotted at deal creation (decimal strings). */
export interface LegSpec {
  contract: string;
  side: Side;
  lot: string;
  minSize: string;
  minNotional: string;
  /** Venue tick size — needed to price banded marketable-limit clips. */
  tick: string;
  /** Reduce-only leg (closes): every order on this leg is reduce-only. */
  reduceOnly?: boolean;
}

/**
 * THE intent row. User commands edit this row and nothing else.
 *
 * Deal shapes (all one machine):
 *  - maker pair:   a = POC maker (OPENING), b = hedge — the classic maker+hedge
 *  - taker pair:   born in CONVERTING — A clips + B hedges to target
 *  - single open:  b = null; maker (rests, no deadline) or taker (clips)
 *  - close:        taker with reduceOnly leg(s); close-pair = both legs reduceOnly
 */
export interface PairRow {
  id: string;
  mode: PairMode;
  a: LegSpec; // leg A = acquiring leg (post-only maker; taker clips when converting)
  b: LegSpec | null; // leg B = hedge leg (market/IOC, opposite exposure); null = single-leg deal
  targetQty: string;
  /** Current maker price intent. Placement writes the price it actually used back
   * here, so "maker price ≠ intent" is exactly "a re-peg was requested". */
  limitPrice: string | null;
  /** How the maker price is derived. Three exclusive modes:
   *  - 'fixed': rest at exactly `limitPrice`.
   *  - 'touch': rest ONE bid–ask gap behind the same-side touch.
   *  - 'best':  rest AT the same-side best price (best bid for BUY, best ask
   *    for SELL), recomputed at the then-current best on every replacement.
   *  'best' is also the four-leg scope marker (spec: scope is
   *  `price_policy === 'best'`); ordinary pairs only ever emit 'fixed'/'touch'. */
  pricePolicy: 'fixed' | 'touch' | 'best';
  /** The AUTO-FOLLOW policy this deal returns to when the user hands control
   * back. Separate from `pricePolicy` because pinning a price OVERWRITES the
   * policy: a pinned four-leg deal carries `pricePolicy === 'fixed'`, so the
   * current value no longer says whether its family quotes at the same-side
   * best ('best') or one spread behind ('touch'). Restoring a `'best'` deal as
   * `'touch'` would silently swap its quoting semantics for the OLD ones.
   * Recorded once at creation (`'best'` for a four-leg deal, `'touch'`
   * otherwise) and never changed — there is no user-adjustable path to it. */
  autoPricePolicy: 'touch' | 'best';
  deadlineAt: number | null;
  makerNotBefore: number; // anti-flap backoff after a POC/clip reject
  hedgeNotBefore: number; // anti-flap backoff after a hedge reject
  pocRejects: number;
  hedgeRejectStreak: number;
  /** Automatic reprice cycles CONSUMED by the 'best' quote loop. Monotone —
   * it is NOT reset when the maker fills (unlike `pocRejects`). Defaults to 0
   * for a row written before the column existed. */
  repriceCount: number;
  /** Consecutive post-only (would-cross) rejections on leg A, for a `'best'`
   * deal ONLY. Kept SEPARATE from `pocRejects` because quoting at the same-side
   * best makes a post-only rejection an expected book-jitter event, not a
   * persistent-wrong-price fault; merging the two let one jitter stop the deal
   * honestly instead of completing the remainder with taker. Reset on any A-leg
   * fill — like `pocRejects`, it counts a CONSECUTIVE streak of zero-progress
   * attempts (a reject is instant death, so N in a row means N quotes refused
   * without resting once). Defaults to 0 for a legacy row. */
  postOnlyRejects: number;
  /** Wall-clock ms of the last maker PLACEMENT — the 15 s minimum-interval gate.
   * A DISTINCT fact from `makerNotBefore` (the old reject backoff); using
   * "time since last reprice" instead would re-price the instant a short stall
   * ends and produce jitter. 0 means "never placed". */
  lastMakerPlacementAt: number;
  /** Wall-clock ms at which the CURRENT book outage began (0 = the book is
   * quotable, or has recovered). The 30 s pause grading is measured from here,
   * so it survives a restart and can never be reset by a tick that happens to
   * succeed. A DISTINCT fact from `lastMakerPlacementAt`: that one is the last
   * time the book was known GOOD, and is used only to invalidate a stale
   * outage marker, never to measure the outage itself. */
  bookOutageStartedAt: number;
  /** Max A-leg clip size during CONVERTING (null = uncapped). */
  maxClip: string | null;
  /** A-clip marketable-limit band in BASIS POINTS (null = pure MARKET IOC).
   * Closes carry the user's slippage here — the clip becomes LIMIT IOC at
   * ref·(1 ± band), the close-protection semantics. */
  clipBandBp: number | null;
  haltReason: string | null;
  reportJson: string | null;
  createdAt: number;
}

/** Write-ahead order registry row: exists (committed) BEFORE the wire call. */
export interface OrderRow {
  pairId: string;
  leg: Leg;
  seq: number;
  /** Deterministic: 't-<pairId>.<leg><seq>' — derivable from durable state, never reused. */
  clientId: string;
  kind: 'maker' | 'taker';
  side: Side;
  qty: string;
  price: string | null;
  tif: 'poc' | 'ioc';
  state: OrderState;
  venueOrderId: string | null;
  /** Venue cumulative fill; monotone (a shrink is corruption → alert + quarantine). */
  cumQty: string;
  /** Venue's average execution price for this order (executed_avg_price); '0'
   * until it fills. Persisted so a leg's realized avg fill survives to finish. */
  avgFillPrice: string;
  closeReason: string | null;
  cancelRequested: 0 | 1;
  /** Raw venue status string the open-world decoder could not classify. */
  quarantinedStatus: string | null;
  /** The venue's own explanation for the last status it reported (label +
   * message). A status alone ("FAIL") tells the user nothing; this is what
   * says whether to retry, resize, or switch venue. */
  venueReason: string | null;
  /** Consecutive failed venue reads on this order (reset by any successful one).
   * A read failure resolves nothing, so a persistent one silently freezes our
   * view of a live order while it keeps filling — this makes that visible. */
  readFailStreak: number;
  createdAt: number;
  resolvedAt: number | null;
}

export interface AlertRow {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  pairId: string | null;
  message: string;
  ack: 0 | 1;
}

// ---------------------------------------------------------------------------
// Venue port — the ONLY surface the loop talks to. Implemented by the real
// Gate adapter (venueGate.ts) and by the simulation's fake venue.
// ---------------------------------------------------------------------------

export interface OrderSnapshot {
  venueOrderId: string;
  /** Verbatim venue status string; decoded open-world by the loop. */
  rawStatus: string;
  cumQty: string;
  /** Venue's own average execution price for THIS order (Gate executed_avg_price);
   * '0' when nothing has filled. The only trustworthy fill price for a market/IOC
   * hedge, whose order `price` is null. */
  avgFillPrice: string;
  /** Venue's cancellation/rejection cause ('' when none). */
  reason: string;
}

/** Three-way, never two-way: 'unknown' is anything that is not a definitively
 * parsed venue business answer — timeouts, resets, ANY 5xx, unmatched labels. */
export type CreateOutcome =
  | { kind: 'ok'; snapshot: OrderSnapshot }
  | { kind: 'reject'; label: string; message: string }
  | { kind: 'unknown'; message: string };

export type CancelOutcome =
  | { kind: 'ok' } // canceled, or already terminal/not found ("no further fills" holds)
  | { kind: 'unknown'; message: string };

export type ReadOutcome =
  | { kind: 'found'; snapshot: OrderSnapshot }
  | { kind: 'notFound' } // AUTHORITATIVE not-found (the read itself succeeded)
  | { kind: 'error'; message: string }; // read failed — resolves NOTHING

export interface SweepResult {
  /** True only when the listings PROVABLY covered [fromMs, now] (symbol-filtered,
   * paginated to exhaustion, every page read succeeded). covered=false must never
   * be treated as absence (hazard 5). */
  covered: boolean;
  found?: OrderSnapshot;
}

export interface VenuePort {
  create(req: {
    contract: string;
    side: Side;
    qty: string;
    price?: string;
    tif: 'poc' | 'ioc';
    reduceOnly?: boolean;
    clientText: string;
  }): Promise<CreateOutcome>;
  cancel(ref: { venueOrderId?: string; clientText: string }): Promise<CancelOutcome>;
  getOrder(ref: { venueOrderId?: string; clientText: string }): Promise<ReadOutcome>;
  sweepForOrder(contract: string, clientText: string, fromMs: number): Promise<SweepResult>;
  /** Best same-side touch price for a resting maker, formatted for the venue
   * (tick-snapped + Hyperliquid 5-sig-fig cap — `tick` is the leg's tick size);
   * null when the book is unavailable. NOTE: this is the OLD `'touch'` semantics
   * — the price rests ONE bid–ask gap BEHIND the same-side touch. It is NOT the
   * `'best'` price; see `bestQuote`. */
  touch(contract: string, side: Side, tick: string): Promise<string | null>;
  /** Best same-side price for a `'best'` quote — the BARE best bid (BUY) / best
   * ask (SELL), with no spread offset, formatted through `formatRestPrice` so
   * the directional tick snap and the Hyperliquid 5-sig-fig cap both apply in
   * the safe direction (BUY down, SELL up). null when the book is unavailable
   * OR degenerate (one-sided, crossed, non-positive levels) — the caller then
   * places nothing rather than quoting off a broken book. */
  bestQuote(contract: string, side: Side, tick: string): Promise<string | null>;
  /** Reference price for min-notional checks; null when unavailable. */
  refPrice(contract: string): Promise<string | null>;
}

export interface Clock {
  now(): number;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface Projection {
  aFilled: string;
  aReserved: string;
  bFilled: string;
  bReserved: string;
  /** max(0, aFilled − bReserved) — what may still be hedged (raw, un-floored). */
  unhedged: string;
  /** max(0, target − aReserved) — what may still be acquired (raw, un-floored). */
  residualA: string;
  /** Newest leg-A maker order, if any. */
  makerOrder: OrderRow | null;
  anyPending: boolean;
  anyQuarantined: boolean;
  /** The first order stuck on a status the decoder cannot classify (any leg).
   * Stop / a halted pair cancels THIS to break the freeze — see decide(). */
  quarantinedOrder: OrderRow | null;
  /** Every order in a settled state (nothing PENDING/OPEN/quarantined). */
  allSettled: boolean;
}

export interface Report {
  aFilled: string;
  bFilled: string;
  unhedged: string;
  reason: string;
  /** Quantity-weighted average fill price per leg (decimal string), populated at
   * finish from the recorded fills. Null when the leg took no fills. Leg A is the
   * maker (limit) leg; leg B is the taker (hedge) leg. */
  aAvgFill?: string | null;
  bAvgFill?: string | null;
}

export type Action =
  | { type: 'idle'; reason?: string }
  | { type: 'setMode'; mode: PairMode; reason: string; haltReason?: string }
  | { type: 'place'; leg: Leg; kind: 'maker' | 'taker'; tif: 'poc' | 'ioc'; qty: string; price?: string }
  | { type: 'cancel'; order: OrderRow; reprice?: boolean }
  | { type: 'finish'; report: Report };

export interface Tuning {
  TICK_MS: number;
  /** Re-tick interval right after the loop ACTED (placed/canceled/mode-edited):
   * convergence sequences (a Stop = hedge → cancel → observe → finish) run at
   * this cadence instead of one step per TICK_MS. Venue reads pace it naturally. */
  FAST_TICK_MS: number;
  /** Before this age an authoritative not-found may still mean "create in flight"
   * (or inside Gate's 60s post-terminal text-lookup grace) — stay PENDING. */
  AMBIGUITY_MS: number;
  POC_BACKOFF_MS: number;
  HEDGE_BACKOFF_MS: number;
  MAX_POC_REJECTS: number;
  HEDGE_REJECT_HALT: number;
  /** Convert clips: caps peak unhedged exposure during completion. */
  MAX_CLIP: string;
  /** Consecutive failed reads on ONE live order before alerting. A live order we
   * cannot read is filling untracked, so this is deliberately small — but not 1,
   * which would fire on any transient blip. */
  READ_FAIL_ALERT: number;
  /** How far a resting `'best'` quote must fall behind the current same-side
   * best, in that contract's ticks, before it is automatically repriced. */
  REPRICE_LAG_TICKS: number;
  /** Minimum wall-clock ms between a maker PLACEMENT and an automatic reprice
   * (measured from `lastMakerPlacementAt`, NOT from the last reprice — see the
   * spec: "time since last reprice" produces jitter after a brief stall). */
  REPRICE_MIN_INTERVAL_MS: number;
  /** Maximum automatic reprice cycles for one deal. Monotone: reaching it keeps
   * the last quote live (no taker conversion) until a fill, a manual command,
   * or the absolute deadline. */
  MAX_REPRICE_CYCLES: number;
  /** Maximum consecutive post-only (would-cross) REJECTIONS of the `'best'`
   * maker before the deal abandons maker acquisition and CONVERTS: it cancels
   * the remainder and completes it with taker. Same magnitude as the reprice
   * quota but wholly INDEPENDENT of it (and of `MAX_POC_REJECTS`, the old
   * taker-clip budget). A `'best'` quote rests at the most easily-crossed
   * position in the book, so this is the same order of magnitude as the number
   * of reprices we tolerate — not the old "5 = the price is wrong" fault cap. */
  MAX_POST_ONLY_REJECTS: number;
  /** How long a `'best'` deal's book may stay unavailable before the resting
   * maker is CANCELLED. Under it the maker is preserved (it can still fill and
   * the loop keeps observing/hedging); over it the pause becomes a cancel —
   * but only while ORDER status reads still work, because the cancel needs no
   * book price, only order state. A fixed default, not a user setting. */
  BOOK_OUTAGE_CANCEL_MS: number;
}

export const TUNING: Tuning = {
  TICK_MS: 1_000,
  FAST_TICK_MS: 150,
  AMBIGUITY_MS: 90_000,
  POC_BACKOFF_MS: 2_000,
  HEDGE_BACKOFF_MS: 3_000,
  MAX_POC_REJECTS: 5,
  HEDGE_REJECT_HALT: 3,
  MAX_CLIP: '1000000000', // effectively uncapped by default; pairs may be created with less
  READ_FAIL_ALERT: 5,
  REPRICE_LAG_TICKS: 2,
  REPRICE_MIN_INTERVAL_MS: 15_000,
  MAX_REPRICE_CYCLES: 20,
  MAX_POST_ONLY_REJECTS: 20,
  BOOK_OUTAGE_CANCEL_MS: 30_000,
};
