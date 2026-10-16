/** Bounded, best-effort diagnostics. Never used to authorize an engine action. */
import { performance } from 'node:perf_hooks';
import type { Store } from './db';
import { sizeFor } from './decide';
import { fx, fxMax, fxStr } from './fx';
import type { LoopDeps } from './loop';
import { recordObservation } from './observation';
import type { OrderRow, PairRow, Projection } from './types';

type WaitState = 'blocked' | 'recovered' | 'not-required' | 'unverified';
interface Wait { start: number; reported: number; invalidClock: boolean }
const waits = new WeakMap<Store, Map<string, Wait>>();
const capacityReported = new WeakMap<Store, number>();
const MAX_WAITS = 256;
const REPORT_INTERVAL_MS = 30_000;

export function forgetHedgeWait(store: Store, pairId: string): void { waits.get(store)?.delete(pairId); }

export function reportHedgeWait(deps: LoopDeps, pair: PairRow, p: Projection, orders: OrderRow[], reference: string | null | undefined): void {
  try {
    let states = waits.get(deps.store);
    if (!states) { states = new Map(); waits.set(deps.store, states); }
    let wait = states.get(pair.id);
    const now = (deps.waitMonotonicNow ?? (() => performance.now()))();
    const whole = pair.b !== null && sizeFor(fx(p.unhedged), pair.b, null) === null;
    const frozen = p.anyPending || p.anyQuarantined;
    if (!wait) {
      if (!whole || frozen || reference !== null || deps.clock.now() < pair.hedgeNotBefore) return;
      if (states.size >= MAX_WAITS) {
        const previous = capacityReported.get(deps.store);
        if (previous !== undefined && (!Number.isFinite(now) || now - previous < REPORT_INTERVAL_MS)) return;
        // One bounded Store-level anchor; acknowledgement cannot bypass throttling.
        // An invalid initial clock has no safe elapsed-time proof: suppress repeats.
        capacityReported.set(deps.store, Number.isFinite(now) ? now : Infinity);
        deps.store.alert('warn', null, 'hedge price reporting capacity reached — wait evidence UNKNOWN', deps.clock.now());
        recordObservation(deps.evidence, 'hedge-wait', { waitState: 'unverified', outcome: 'unknown', reason: 'wait reporting capacity' });
        return;
      }
      wait = { start: now, reported: -Infinity, invalidClock: !Number.isFinite(now) };
      states.set(pair.id, wait);
    }
    if (!Number.isFinite(now) || now < wait.start || now < wait.reported) wait.invalidClock = true;
    const duration = wait.invalidClock ? null : now - wait.start;
    const state: WaitState = !whole ? 'not-required' : reference !== undefined && reference !== null ? 'recovered'
      : frozen || reference === undefined ? 'unverified' : 'blocked';
    const ended = state === 'not-required' || state === 'recovered';
    if (!ended && wait.reported !== -Infinity && !wait.invalidClock && now - wait.reported < REPORT_INTERVAL_MS) return;
    // Invalid injected clocks never cause an alert per tick. The throttle uses
    // the last safe anchor until an ordinary monotonic sample advances again.
    if (!ended && wait.invalidClock && wait.reported !== -Infinity) return;
    wait.reported = now;
    if (ended) states.delete(pair.id);
    const verified = !frozen && !orders.some(o => o.readFailStreak > 0);
    const actual = verified ? fxStr(fxMax(0n, fx(p.aFilled) - fx(p.bFilled))) : null;
    const reason = state === 'blocked' ? 'required reference unavailable' : state === 'recovered'
      ? 'required reference available; other engine gates still apply' : state === 'not-required'
        ? 'no submittable unreserved obligation; source recovery unverified' : 'order or price evidence incomplete';
    recordObservation(deps.evidence, 'hedge-wait', { contract: pair.b?.contract, waitState: state,
      startedMonoMs: Number.isFinite(wait.start) ? wait.start : undefined, waitMs: duration,
      unreserved: p.unhedged, actualUnhedged: actual, outcome: verified ? 'ok' : 'unknown', reason });
    deps.store.alert(ended ? 'info' : 'warn', pair.id,
      `hedge price ${state}: ${reason}; unreserved ${p.unhedged} base; confirmed exposure ${actual ?? 'UNKNOWN'} base; ` +
      `observed wait ${duration === null ? 'UNKNOWN' : Math.floor(duration)}ms (process-local); source time UNKNOWN`, deps.clock.now());
  } catch {
    recordObservation(deps.evidence, 'hedge-wait', { waitState: 'unverified', outcome: 'unknown', reason: 'wait reporting failed' });
  }
}
