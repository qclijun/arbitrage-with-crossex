/** Stub settled-history venues and a fake-clock round driver for the funding history cache/refresher tests. */
import { vi } from 'vitest';
import { FundingHistoryCache, legKey, type HistoryLegKey } from '../../src/core/funding/history-cache';
import {
  createFundingHistoryRefresher,
  type FundingHistorySource,
  type HistoryBudget,
  type HistoryCall,
} from '../../src/core/funding/history-collector';

export const M = 60_000;
export const H = 60 * M;
export const D = 24 * H;
/** 2026-10-01 10:00 UTC, on the 8-hour grid anchored at the epoch. */
export const T = Date.UTC(2026, 9, 1, 10);

export type Fail = 'rate-limited' | 'error' | 'hang';

/** Times on the `hours` UTC grid in (from, to]. */
export function grid(hours: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = Math.floor(from / (hours * H)) * hours * H + hours * H; t <= to; t += hours * H) out.push(t);
  return out;
}

/** One venue serving settled history, 8-hourly unless `times` lists every raw time; `fail` and `pageSize` script its behavior. */
export function stubSource(venue: 'BINANCE' | 'BYBIT', opts: { pageSize?: number; fail?: () => Fail | null; drop?: number; delayMs?: number;
  times?: () => readonly number[] } = {}) {
  const calls: string[] = [];
  let inflight = 0;
  let peak = 0;
  const api = venue === 'BINANCE' ? '/fapi/v1/fundingRate' : '/v5/market/funding/history';
  const row = (contractId: string, time: number) => venue === 'BINANCE'
    ? { symbol: contractId, fundingTime: time, fundingRate: '0.0001' }
    : { symbol: contractId, fundingRateTimestamp: String(time), fundingRate: '-0.0001' };
  const source: FundingHistorySource = {
    venue,
    api,
    version: 'stub-v1',
    context: async (contractId: string) => ({ listing: { at: 0, evidence: `${venue}/${contractId}/listing` } }),
    page: (contractId, range, cursor, call: HistoryCall) => call(`${venue} ${contractId} ${range.start}-${range.end} ${cursor ?? ''}`, async () => {
      calls.push(`${contractId}:${range.start}:${cursor ?? ''}`);
      inflight += 1;
      peak = Math.max(peak, inflight);
      try {
        await (opts.delayMs ? new Promise((resolve) => setTimeout(resolve, opts.delayMs)) : Promise.resolve());
        const failure = opts.fail?.() ?? null;
        if (failure === 'hang') await new Promise(() => undefined);
        if (failure === 'rate-limited') throw Object.assign(new Error('429'), { response: { status: 429 } });
        if (failure === 'error') throw new Error('boom');
        const from = cursor === null ? range.start : Number(cursor);
        const times = (opts.times?.() ?? grid(8, from, range.end).filter((t) => t !== opts.drop))
          .filter((t) => t > from && t <= range.end).sort((a, b) => a - b);
        const size = opts.pageSize ?? times.length;
        const rows = times.slice(0, size);
        const done = rows.length === times.length;
        return {
          rows: rows.map((t) => row(contractId, t)),
          rawHash: `hash:${contractId}:${from}`,
          firstAt: rows[0] ?? null,
          lastAt: rows.at(-1) ?? null,
          cursor: done ? null : String(rows.at(-1)),
          done,
        };
      } finally {
        inflight -= 1;
      }
    }),
  };
  return { source, calls, peak: () => peak };
}

export const BTC = { binance: { venue: 'BINANCE', contractId: 'BTCUSDT' }, bybit: { venue: 'BYBIT', contractId: 'BTCUSDT' } };
export const leg = (venue: 'BINANCE' | 'BYBIT', contractId: string): HistoryLegKey => ({ venue, contractId });
export const pair = (days: 7 | 30 | 90 | 180 | 365 = 30) => ({ underlying: 'BTC', short: BTC.binance, long: BTC.bybit, days });

/** Drive a round to completion under fake timers (retry jitter, timeouts, spacing). */
export async function run<T>(refresher: { runOnce(): Promise<T> }): Promise<T> {
  const done = refresher.runOnce();
  await vi.runAllTimersAsync();
  return done;
}

/**
 * The market's current official intervals for `legs`, quoted at each read. Mutate `hours` to
 * change a venue's interval between rounds.
 */
export function currentFor(legs: HistoryLegKey[], hours: Record<string, number> = { BINANCE: 8, BYBIT: 8, HYPERLIQUID: 1 }) {
  return () => new Map(legs.filter((k) => hours[k.venue] !== undefined)
    .map((k) => [legKey(k), { intervalHours: hours[k.venue]!, at: Date.now() }]));
}

export function setup(opts: {
  binance?: Parameters<typeof stubSource>[1];
  bybit?: Parameters<typeof stubSource>[1];
  legs?: HistoryLegKey[];
  budget?: Partial<HistoryBudget>;
  current?: Record<string, number>;
} = {}) {
  const cache = new FundingHistoryCache();
  const binance = stubSource('BINANCE', opts.binance);
  const bybit = stubSource('BYBIT', opts.bybit);
  const legs = opts.legs ?? [BTC.binance, BTC.bybit];
  const refresher = createFundingHistoryRefresher({
    cache, sources: [binance.source, bybit.source], legs: async () => legs,
    currentSchedules: currentFor(legs, opts.current), random: () => 0, budget: opts.budget,
  });
  return { cache, binance, bybit, refresher };
}
