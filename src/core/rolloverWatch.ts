import profile from '../../scripts/rollover-watch-profile.json';
import type { RiskBorosPosition } from './risk';
import type { BorosRollSimulation } from './boros/orders';
import type { BorosRollSimulateResponse } from '../../web/src/api/types';

export { profile as rolloverWatchProfile };
export type WatchSimulation = BorosRollSimulateResponse & { venue?: BorosRollSimulation | null };
export const watchFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const sameWatchSize = (v: unknown, size: number) => watchFinite(v) && Math.abs(v - size) <= 1e-9;
export interface WatchProgress { remaining: number; rolled: number; state: 'UNSTARTED' | 'PARTIAL' | 'ROLLED' | 'EXITED' }

/** Quantity conservation proves progress, not a successful execution receipt. */
export function watchProgress(positions: RiskBorosPosition[]): WatchProgress {
  const read = (id: number, side: string, venue: string, maturity: number, entry?: number) => {
    const rows = positions.filter(p => p.marketId === id);
    if (!rows.length) return 0;
    const p = rows[0];
    if (rows.length !== 1 || p.marketAcc.toLowerCase() !== profile.address + '000002ffffff'
      || p.tokenId !== 2 || p.base !== 'ETH' || p.venue?.toUpperCase() !== venue || p.side !== side
      || !watchFinite(p.sizeToken) || p.sizeToken < 0 || p.maturity !== maturity
      || entry !== undefined && (!watchFinite(p.entryApr) || Math.abs(p.entryApr - entry) > .0001 + 1e-12)) {
      throw new Error('Watch position identity, quantity or locked entry changed');
    }
    return p.sizeToken;
  };
  const old = profile.legs.map(p => read(p.marketId, p.side, p.venue, profile.oldMaturity, p.entryApr));
  const next = profile.legs.map(p => read(p.targetId, p.side, p.venue, profile.newMaturity));
  if (!sameWatchSize(old[0], old[1]) || !sameWatchSize(next[0], next[1])) throw new Error('Unbalanced old/new legs — reconcile execution before another batch');
  if (old[0] === 0 && next[0] === 0) return { remaining: 0, rolled: 0, state: 'EXITED' };
  if (!sameWatchSize(old[0] + next[0], profile.totalSize)) throw new Error('Old remaining + new rolled does not equal the approved total');
  return { remaining: old[0], rolled: next[0], state: old[0] === 0 ? 'ROLLED' : next[0] > 0 ? 'PARTIAL' : 'UNSTARTED' };
}

export function watchRequest(address: string, size: number) {
  return { address, exit: { legs: profile.legs.map(p => ({ marketId: p.marketId,
    direction: p.side === 'LONG' ? 'short' : 'long', size, slippageApr: profile.exitTolerance })) },
  entry: { legs: profile.legs.map(p => ({ marketId: p.targetId,
    direction: p.side.toLowerCase(), size, slippageApr: profile.entryTolerance })) } };
}

export function watchPreview(sim: WatchSimulation, size: number, now: number) {
  if (!watchFinite(sim.simulatedAtMs) || sim.simulatedAtMs / 1000 > now || now - sim.simulatedAtMs / 1000 > 120
    || !Array.isArray(sim.gate?.blockers) || !Array.isArray(sim.gate?.warnings)) throw new Error('Invalid/stale batch snapshot');
  const legs = [...sim.exit.simulation.legs, ...sim.entry.simulation.legs];
  if (legs.length !== 4 || legs.some((l, i) => {
    const p = profile.legs[i % 2], close = i < 2;
    const direction = close ? p.side === 'LONG' ? 'short' : 'long' : p.side.toLowerCase();
    return l.marketId !== (close ? p.marketId : p.targetId) || l.direction !== direction
      || l.venue.toUpperCase() !== p.venue || l.base !== 'ETH' || !sameWatchSize(Math.abs(l.sizing.deltaSize), size)
      || l.sizing.orderSide !== direction || !sameWatchSize(l.slippageApr, close ? profile.exitTolerance : profile.entryTolerance);
  }) || sim.exit.simulation.collateral !== 'ETH' || sim.entry.simulation.collateral !== 'ETH'
    || Math.abs(sim.simulatedAtMs / 1000 + sim.entry.simulation.secondsToMaturity - profile.newMaturity) > 120
    || Math.abs(sim.simulatedAtMs / 1000 + sim.exit.simulation.secondsToMaturity - profile.oldMaturity) > 120) {
    throw new Error('Four-leg plan, size, tolerance or maturity mismatch');
  }
  const depths = legs.map(l => ['ok', 'insufficient-depth'].includes(l.bookStatus) && watchFinite(l.sizeWithinTolerance)
    && l.sizeWithinTolerance >= 0 ? l.sizeWithinTolerance : null);
  const depth = depths.every(watchFinite) ? Math.min(...depths) : null;
  const venue = sim.venue, margin = sim.gate.margin;
  const venueComplete = Boolean(venue && ['Succeed', 'Refused'].includes(venue.status) && venue.orders.length === 4
    && venue.orders.every((o, i) => o.marketId === legs[i].marketId && o.action === (i < 2 ? 'close' : 'open')));
  const ready = !venueComplete ? null : venue!.status === 'Refused' || sim.gate.blockers.length > 0 ? false
    : !watchFinite(sim.gasBalanceUsd) || !watchFinite(margin.availableAfter) || !watchFinite(margin.availableAfterExit)
      || !watchFinite(margin.need) || !watchFinite(margin.shortfall) || depth === null
      || !legs.every(l => watchFinite(l.execApr) && watchFinite(l.midApr)) ? null
      : venue!.orders.every(o => o.filled && sameWatchSize(o.matchedSize, size) && !o.error)
        && sim.gasBalanceUsd >= profile.gasMinimumUsd && margin.availableAfter >= 0 && margin.shortfall === 0
        && depth + 1e-9 >= size && legs.every(l => Math.abs(l.execApr! - l.midApr!) <= l.slippageApr + 1e-12);
  return { ready, depth, coverage: depth === null ? null : Math.min(1, depth / size), venueComplete, legs };
}

/** A bounded candidate search; largest verified candidate is not a global maximum.
 * The probe grid is advisory, not a venue lot size or an approved trial size.
 */
export function nextWatchProbe(upper: number, previous: number | null, price: number | null) {
  if (!watchFinite(price) || price <= 0) return null;
  const grid = 10 ** profile.probeDecimals;
  const size = Math.floor((previous === null ? upper : previous / 2) * grid) / grid;
  return size > 0 && size * price >= profile.minimumOrderUsd ? size : null;
}
