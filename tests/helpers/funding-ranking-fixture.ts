/** Synthetic year-long settled histories published straight into the read-only cache, for ranking tests. */
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import type { FundingHistoryLeg } from '../../src/core/funding/history';
import type { LiveFundingContract } from '../../src/core/funding/ranking';

export const M = 60_000;
export const H = 60 * M;
export const D = 24 * H;
/** 2026-10-01 00:00 UTC, on the 8-hour grid anchored at the epoch. */
export const CUTOFF = Date.UTC(2026, 9, 1);
export const NOW = CUTOFF + 2 * M;

const API: Record<string, string> = {
  BINANCE: '/fapi/v1/fundingRate',
  BYBIT: '/v5/market/funding/history',
  ASTER: '/fapi/v3/fundingRate',
  OKX: '/api/v5/public/funding-rate-history',
};

export function live(venue: string, contractId: string, underlying = 'BTC', rateBasis = 'per-settlement'): LiveFundingContract {
  return {
    venue,
    contractId,
    underlying: { id: underlying, evidence: `${venue}/${contractId}/underlying` },
    rateBasis: { id: rateBasis, evidence: `${venue}/${contractId}/basis` },
  };
}

/** `rate(t)` is the settled rate at 8-hour settlement `t`; `drop` removes one settlement. */
export function historyLeg(venue: string, contractId: string, rate: (t: number) => string, opts: { drop?: number; verifiedAt?: number } = {}): FundingHistoryLeg {
  const start = CUTOFF - 365 * D;
  const events: FundingHistoryLeg['events'] = [];
  for (let t = start + 8 * H; t <= CUTOFF; t += 8 * H) {
    if (t === opts.drop) continue;
    events.push({ settledAt: t, rate: rate(t), intervalHours: 8, status: 'settled', kind: 'regular', evidence: `${venue}/${t}` });
  }
  const at = opts.verifiedAt ?? CUTOFF + M;
  return {
    venue,
    contractId,
    source: { kind: 'settled-history', api: API[venue], version: 'v1', status: 'verified' },
    observedAt: at,
    verifiedAt: at,
    lastAttempt: { at, outcome: 'success' },
    listing: { at: 0, evidence: `${venue}/${contractId}/listing` },
    pages: { complete: true, rangeStart: start, rangeEnd: CUTOFF,
      pages: [{ request: 'synthetic year', firstAt: start + 8 * H, lastAt: CUTOFF, count: events.length, cursor: null, rawHash: 'hash' }],
      termination: 'past window start' },
    rules: [{ from: 0, until: CUTOFF + H, everyHours: 8, anchor: 0, evidence: 'synthetic schedule' }],
    events,
  };
}

/** Constant rate, or `recent` for the last 7 days and `rate` before them. */
export const flat = (rate: string, recent = rate) => (t: number) => (t > CUTOFF - 7 * D ? recent : rate);

export function publish(legs: FundingHistoryLeg[], id = 'snap-1'): FundingHistoryCache {
  const cache = new FundingHistoryCache();
  cache.publish(
    { id, cutoff: CUTOFF, publishedAt: CUTOFF + M, legs: new Map(legs.map((leg) => [legKey(leg), { cutoff: CUTOFF, leg }])) },
    { startedAt: CUTOFF + M, finishedAt: CUTOFF + M, cutoff: CUTOFF, outcome: 'published', requests: 0, venues: {} },
  );
  return cache;
}
