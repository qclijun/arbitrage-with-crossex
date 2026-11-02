/** Deterministic hourly HL pages under the real production round budget. */
import { vi } from 'vitest';
import { createFundingServices } from '../../src/server/funding/services';
import { FUNDING_FEEDS } from '../../src/core/funding/feeds';
import { HistoryRateLimitError, type FundingHistorySource } from '../../src/core/funding/history-collector';
import { H, T } from './funding-history-stub';

export function hlBackfillWorld() {
  vi.useFakeTimers({ now: T + 60_000 });
  vi.spyOn(FUNDING_FEEDS, 'HYPERLIQUID').mockResolvedValue([]);
  const calls: Array<{ coin: string; start: number; end: number; cursor: string | null }> = [];
  const control = { failure: null as 'timeout' | 'rate-limited' | null, failBefore: Infinity, revised: false, reviseBefore: -Infinity, allowBeforeFailure: 0 };
  const source: FundingHistorySource = {
    venue: 'HYPERLIQUID', api: 'info:fundingHistory', version: 'fixture', staged: true,
    context: async () => ({ listing: { at: 0, evidence: 'synthetic listing' }, rules: [] }),
    page(coin, range, cursor, call) {
      return call(`${coin}:${range.start}:${range.end}:${cursor}`, async () => {
        calls.push({ coin, ...range, cursor });
        if (control.failure && range.start < control.failBefore && control.allowBeforeFailure-- <= 0) {
          if (control.failure === 'timeout') return new Promise(() => undefined);
          if (control.failure === 'rate-limited') throw new HistoryRateLimitError();
        }
        const from = cursor === null ? range.start : Number(cursor);
        const times: number[] = [];
        for (let t = from + H; t <= range.end && times.length < 100; t += H) times.push(t);
        const done = times.at(-1) === range.end;
        return { rows: times.map((time) => ({ coin, time, fundingRate: control.revised || time < control.reviseBefore ? '0.0002' : '0.0001' })),
          firstAt: times[0] ?? null, lastAt: times.at(-1) ?? null, rawHash: `hash:${from}:${control.revised}`,
          cursor: done ? null : String(times.at(-1)), done };
      });
    },
  };
  const services = createFundingServices({ sources: [source], contracts: async () => ['BTC', 'ETH'].map((coin) => ({
    venue: 'HYPERLIQUID', contractId: coin, symbol: `HYPERLIQUID_FUTURE_${coin}_USDC`, underlying: null, rateBasis: null,
  })) });
  const result = (coin: string, days: 7 | 30 | 90 | 180 | 365) => {
    const key = { venue: 'HYPERLIQUID', contractId: coin };
    return services.funding.history.evaluate({ short: key, long: key, underlying: coin, days }, Date.now());
  };
  return { services, calls, control, result };
}
