/** Stub settled-history venues and a fake-clock round driver for the funding history cache/refresher tests. */
import { vi } from 'vitest';
import { FundingHistoryCache, type HistoryLegKey } from '../../src/core/funding/history-cache';
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

/** One venue serving settled 8-hour history; `fail` and `pageSize` script its behavior. */
export function stubSource(venue: 'BINANCE' | 'BYBIT', opts: { pageSize?: number; fail?: () => Fail | null; drop?: number; delayMs?: number } = {}) {
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
    context: async (contractId: string) => ({
      listing: { at: 0, evidence: `${venue}/${contractId}/listing` },
      rules: [{ from: 0, until: T + 30 * D, everyHours: 8, anchor: 0, evidence: `${venue}/rules` }],
    }),
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
        const times: number[] = [];
        for (let t = Math.floor(from / (8 * H)) * 8 * H + 8 * H; t <= range.end; t += 8 * H) if (t > from && t !== opts.drop) times.push(t);
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

export function setup(opts: {
  binance?: Parameters<typeof stubSource>[1];
  bybit?: Parameters<typeof stubSource>[1];
  legs?: HistoryLegKey[];
  budget?: Partial<HistoryBudget>;
} = {}) {
  const cache = new FundingHistoryCache();
  const binance = stubSource('BINANCE', opts.binance);
  const bybit = stubSource('BYBIT', opts.bybit);
  const refresher = createFundingHistoryRefresher({
    cache, sources: [binance.source, bybit.source], legs: async () => opts.legs ?? [BTC.binance, BTC.bybit],
    random: () => 0, budget: opts.budget,
  });
  return { cache, binance, bybit, refresher };
}
