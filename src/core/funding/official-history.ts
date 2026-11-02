/** Official settled-history IO. Current funding feeds never enter this boundary. */
import { createHash } from 'node:crypto';
import { createOfficialPublicReader, type PublicRead } from './official-public';
import type { FundingHistorySource, HistoryCall, HistorySourcePage } from './history-collector';
import { settlementTimeMapping } from './settlement-time';
import { withOkxArchive } from './okx-history';
import { HYPERLIQUID_HOURLY_POLICY, type HyperliquidHourlyPolicy } from './hyperliquid-policy';
import { createHyperliquidHistoryContext } from './hyperliquid-history';
import { gateHistorySource } from './gate-history';
import { lighterHistorySource } from './lighter-history';

type Row = Record<string, unknown>;
interface Endpoint { venue: string; host: string; api: string; limit: number; direction: 'forward' | 'backward'; }
const ENDPOINTS: Endpoint[] = [
  { venue: 'BINANCE', host: 'https://fapi.binance.com', api: '/fapi/v1/fundingRate', limit: 1000, direction: 'forward' },
  { venue: 'ASTER', host: 'https://fapi.asterdex.com', api: '/fapi/v3/fundingRate', limit: 1000, direction: 'forward' },
  { venue: 'OKX', host: 'https://www.okx.com', api: '/api/v5/public/funding-rate-history', limit: 400, direction: 'backward' },
  { venue: 'HYPERLIQUID', host: 'https://api.hyperliquid.xyz', api: 'info:fundingHistory', limit: 500, direction: 'forward' },
  { venue: 'BYBIT', host: 'https://api.bybit.com', api: '/v5/market/funding/history', limit: 200, direction: 'backward' },
];

function rowsOf(venue: string, data: any): Row[] {
  if (venue === 'OKX' && data?.code !== '0') throw new Error('official-api-error');
  if (venue === 'BYBIT' && data?.retCode !== 0) throw new Error('official-api-error');
  const rows: unknown = venue === 'OKX' ? data.data : venue === 'BYBIT' ? data.result?.list : data;
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('invalid-history-page');
  return rows as Row[];
}

function timestamp(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))
    || !Number.isSafeInteger(Number(value))) throw new Error('invalid-history-time');
  return Number(value);
}

type HistoryContext = Awaited<ReturnType<FundingHistorySource['context']>>;
export interface OfficialHistoryOptions {
  now?: () => number;
  read?: PublicRead;
  /** Trusted reviewed policy dependency; production uses the pinned built-in evidence. */
  hlPolicy?: HyperliquidHourlyPolicy;
  /** Optional stricter per-record mapping, overriding the bounded venue default. */
  hlSettlements?: ReadonlyMap<number, { settlementAt: number; evidence: string }>;
  context?: (venue: string, contractId: string, call: HistoryCall) => HistoryContext | Promise<HistoryContext>;
}

function restSource(e: Endpoint, read: PublicRead, opts: OfficialHistoryOptions): FundingHistorySource {
  const hlContext = e.venue === 'HYPERLIQUID' ? createHyperliquidHistoryContext({ read, now: opts.now ?? Date.now, policy: opts.hlPolicy }) : null;
  return {
    venue: e.venue, api: e.api,
    version: hlContext ? `official-v1:${(opts.hlPolicy ?? HYPERLIQUID_HOURLY_POLICY).version}:${(opts.hlPolicy ?? HYPERLIQUID_HOURLY_POLICY).current.sha256}` : 'official-v1',
    ...(e.venue === 'OKX' ? { maxDays: 90 } : {}),
    // 20 hourly days fit below the 500-row page cap, retaining 7d coverage
    // while saving a page per cold leg for the budgeted document proof.
    ...(hlContext ? { staged: true, initialReadDays: 20 } : {}),
    ...(['HYPERLIQUID', 'ASTER'].includes(e.venue) ? { timeMapping: (row: Row) => {
      const time = e.venue === 'HYPERLIQUID' ? row.time : row.fundingTime;
      return e.venue === 'HYPERLIQUID' && opts.hlSettlements
        ? opts.hlSettlements.get(timestamp(time)) : settlementTimeMapping(e.venue, time);
    } } : {}),
    // Today's instrument metadata does not prove historical funding cadence.
    context: async (id, call) => {
      const native = await opts.context?.(e.venue, id, call) ?? null;
      return hlContext ? hlContext(id, native, call) : native;
    },
    async page(contractId, range, cursor, call): Promise<HistorySourcePage> {
      const hl = e.venue === 'HYPERLIQUID';
      const delayed = hl || e.venue === 'ASTER' || e.venue === 'BINANCE';
      // Include sub-second processing timestamps after the settlement cutoff.
      // Raw query bounds are independent of cadence and listing evidence.
      const rawStart = hl ? range.start + 3_600_000 : range.start + 1;
      const rawEnd = delayed ? range.end + 999 : range.end;
      const boundary = cursor === null ? (e.direction === 'forward' ? rawStart : range.end) : timestamp(cursor);
      if (!contractId || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start >= range.end
        || !Number.isSafeInteger(rawEnd) || boundary < rawStart || boundary > rawEnd) throw new Error('invalid-history-range');
      const url = new URL(e.host + (hl ? '/info' : e.api));
      const params = e.venue === 'OKX'
        ? { instId: contractId, before: range.start, after: cursor === null ? range.end + 1 : boundary, limit: e.limit }
        : { symbol: contractId, startTime: e.direction === 'forward' ? boundary : range.start + 1,
          endTime: e.direction === 'forward' ? rawEnd : boundary, limit: e.limit,
          ...(e.venue === 'BYBIT' ? { category: 'linear' } : {}) };
      const body = hl ? { type: 'fundingHistory', coin: contractId, startTime: boundary, endTime: rawEnd } : undefined;
      if (!hl) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const data = await call(`${hl ? 'POST' : 'GET'} ${url}${body ? ` ${JSON.stringify(body)}` : ''}`,
        (signal) => read(e.venue, url.toString(), signal, body));
      const rows = rowsOf(e.venue, data);
      const times = rows.map((row) => {
        if ((hl ? row.coin : e.venue === 'OKX' ? row.instId : row.symbol) !== contractId) throw new Error('history-contract-mismatch');
        return timestamp(hl ? row.time : e.venue === 'BYBIT' ? row.fundingRateTimestamp : row.fundingTime);
      });
      if (times.some((t) => t < rawStart || t > rawEnd
        || (e.direction === 'forward' ? t < boundary : e.venue === 'OKX' && cursor !== null ? t >= boundary : t > boundary))) {
        throw new Error('history-outside-request');
      }
      const firstAt = times.length ? Math.min(...times) : null;
      const lastAt = times.length ? Math.max(...times) : null;
      const next = e.direction === 'forward' ? lastAt : firstAt;
      const done = rows.length < e.limit;
      if (rows.length > e.limit || (!done && (next === null
        || (e.direction === 'forward' ? next <= boundary : next >= boundary)))) throw new Error('pagination-stalled');
      return { rows, firstAt, lastAt, done, cursor: done ? null : String(next),
        rawHash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
    },
  };
}

export function createOfficialHistorySources(opts: OfficialHistoryOptions = {}): FundingHistorySource[] {
  const read = opts.read ?? createOfficialPublicReader({ now: opts.now });
  const now = opts.now ?? Date.now;
  return [...ENDPOINTS.map((endpoint) => {
    const source = restSource(endpoint, read, opts);
    return endpoint.venue === 'OKX' ? withOkxArchive(source, read, now) : source;
  }), gateHistorySource(read, now, (id, call) => opts.context?.('GATE', id, call) ?? null),
  lighterHistorySource(read, now, (id, call) => opts.context?.('LIGHTER', id, call) ?? null)];
}
