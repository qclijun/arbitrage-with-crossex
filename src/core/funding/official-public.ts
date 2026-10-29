/** Shared public-only IO: bounded reads, per-instance quotas and server cooldowns. */
import axios from 'axios';
import { bookRequestOptions } from '../estimate/books';
import { HistoryRateLimitError } from './history-collector';

export type PublicRead = (venue: string, url: string, signal: AbortSignal, body?: object) => Promise<unknown>;
export interface PublicReadSample {
  venue: string; url: string; status: number; elapsedMs: number;
  headers: Record<string, string>; estimatedWeight: number;
  weights: { minuteUsed: number | null; genericUsed: number | null; minuteLimit: number | null };
}
const QUOTAS: Record<string, [number, number]> = {
  BINANCE: [400, 300_000], ASTER: [30, 60_000], OKX: [8, 2_000], BYBIT: [100, 5_000], HYPERLIQUID: [900, 60_000],
};
const HEADER_NAMES = ['retry-after', 'x-mbx-used-weight', 'x-mbx-used-weight-1m',
  'x-bapi-limit', 'x-bapi-limit-status', 'x-bapi-limit-reset-timestamp'];

/** Retry-After supports delay-seconds or an HTTP date. No header means no proof. */
export function retryAfterMs(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function createOfficialPublicReader(opts: { now?: () => number; sample?: (s: PublicReadSample) => void } = {}): PublicRead {
  const now = opts.now ?? Date.now;
  const states = new Map<string, { until: number; used: number; blockedUntil: number; minuteLimit?: number }>();
  return async (venue, url, signal, body) => {
    const at = now();
    const [capacity, period] = QUOTAS[venue] ?? [10, 60_000];
    let state = states.get(venue);
    if (!state) states.set(venue, state = { until: at + period, used: 0, blockedUntil: 0 });
    if (at >= state.until) { state.until = at + period; state.used = 0; }
    // Reserve worst-case response weight before starting concurrent HL requests.
    const weight = venue === 'HYPERLIQUID' ? 45 : 1;
    if (state.blockedUntil > at || state.used + weight > capacity) {
      throw new HistoryRateLimitError('public-read-cooldown', Math.max(state.blockedUntil, state.used + weight > capacity ? state.until : at) - at);
    }
    state.used += weight;
    const response = await axios.request({ ...bookRequestOptions(), timeout: 5_000, method: body ? 'POST' : 'GET',
      url, data: body, signal, validateStatus: () => true, maxContentLength: 16 * 1024 * 1024 });
    const headers: Record<string, string> = {};
    for (const name of HEADER_NAMES) {
      const value = response.headers[name];
      if (typeof value === 'string' || typeof value === 'number') headers[name] = String(value);
    }
    const data = response.data;
    const actualWeight = venue === 'HYPERLIQUID' ? 20 + (Array.isArray(data) ? Math.ceil(data.length / 20) : 0) : 1;
    if (actualWeight > weight) state.used += actualWeight - weight;
    const numericHeader = (name: string): number | null => {
      const raw = headers[name];
      if (raw === undefined || !/^\d+$/.test(raw)) return null;
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : null;
    };
    const declared = Array.isArray(data?.rateLimits) ? data.rateLimits.filter((r: any) =>
      r?.rateLimitType === 'REQUEST_WEIGHT' && r.interval === 'MINUTE' && r.intervalNum === 1
      && Number.isSafeInteger(r.limit) && r.limit > 0).map((r: any) => r.limit as number) : [];
    if (declared.length) state.minuteLimit = Math.min(state.minuteLimit ?? Infinity, ...declared);
    const weights = { minuteUsed: numericHeader('x-mbx-used-weight-1m'), genericUsed: numericHeader('x-mbx-used-weight'),
      minuteLimit: state.minuteLimit ?? null };
    // Minute weight is NOT the Binance fundingRate/fundingInfo 500/5min
    // request counter. Only compare it to a separately declared minute cap.
    if (weights.minuteUsed !== null && weights.minuteLimit !== null && weights.minuteUsed >= weights.minuteLimit * 0.8) {
      state.blockedUntil = Math.max(state.blockedUntil, now() + 60_000);
    }
    opts.sample?.({ venue, url, status: response.status, elapsedMs: now() - at, headers, estimatedWeight: actualWeight, weights });
    const code = data?.retCode ?? data?.code;
    const limited = response.status === 429 || response.status === 418 || code === 10006 || code === 10429
      || code === -1003 || code === '50011' || code === '50040';
    const delay = retryAfterMs(headers['retry-after'], now());
    const reset = Number(headers['x-bapi-limit-reset-timestamp']);
    if (limited || delay !== null || headers['x-bapi-limit-status'] === '0') {
      const cooldown = Math.max(delay ?? 0, Number.isSafeInteger(reset) ? reset - now() : 0,
        limited || headers['x-bapi-limit-status'] === '0' ? 60_000 : 0);
      state.blockedUntil = Math.max(state.blockedUntil, now() + cooldown);
      if (limited) throw new HistoryRateLimitError('official-rate-limit', cooldown);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`official-http-${response.status}`);
    return data;
  };
}
