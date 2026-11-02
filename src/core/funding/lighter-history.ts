/**
 * Lighter perp settled funding history (`GET /api/v1/fundings`, 1h). Probed
 * 2026-11-02: rows `{ timestamp: s, value, rate, direction }` oldest first, on
 * the hour; `rate` is an unsigned percent per hour and `direction: short` makes
 * it negative; rows match `start <= t < end`, keep the newest 750, and drop the
 * oldest match unless `end` reaches the newest row. Settled-rate evidence:
 * .scratch/funding-gate-lighter-history/evidence/lighter-settled-history.md.
 */
import { createHash } from 'node:crypto';
import { snapshotCutoff } from './history';
import type { FundingHistorySource, HistoryCall, HistorySourcePage } from './history-collector';
import type { PublicRead } from './official-public';
import { LIGHTER_HISTORY_API } from './history-sources';

const HOUR_S = 3_600;
const LIMIT = 750;
const HOST = 'https://mainnet.zklighter.elliot.ai';
type Context = Awaited<ReturnType<FundingHistorySource['context']>>;
interface Market { marketId: number; evidence: string }

/** The one perp book named `contractId`: a spot book can share the base name. */
function perpMarket(data: any, contractId: string, evidence: string): Market {
  const hits = data.order_books.filter((b: any) => b?.symbol === contractId && b.market_type === 'perp');
  if (hits.length !== 1 || !Number.isSafeInteger(hits[0].market_id) || hits[0].market_id < 0) throw new Error('history-market-unmapped');
  return { marketId: hits[0].market_id, evidence };
}

export function lighterHistorySource(read: PublicRead, now: () => number,
  context: (contractId: string, call: HistoryCall) => Context | Promise<Context>): FundingHistorySource {
  // One order-book read per hour maps every contract; a failed or refused read is retried.
  let books: { cutoff: number; pending: Promise<{ data: unknown; evidence: string }> } | null = null;
  const markets = new Map<string, Market>();
  const listedAt = new Map<string, number | null>();
  return {
    venue: 'LIGHTER', api: LIGHTER_HISTORY_API, version: 'official-v1', staged: true,
    // A page holds 31 hourly days: the recent segment is one read.
    initialReadDays: 30,
    async context(contractId, call) {
      const cutoff = snapshotCutoff(now());
      if (books?.cutoff !== cutoff) {
        const url = `${HOST}/api/v1/orderBooks`;
        const entry = { cutoff, pending: call(`GET ${url}`, (signal) => read('LIGHTER', url, signal)).then((data: any) => {
          if (data?.code !== 200 || !Array.isArray(data.order_books)) throw new Error('invalid-instrument-response');
          return { data, evidence: `GET ${url}#${createHash('sha256').update(JSON.stringify(data)).digest('hex')}` };
        }) };
        books = entry;
        entry.pending.catch(() => { if (books === entry) books = null; });
      }
      const { data, evidence } = await books.pending;
      markets.set(contractId, perpMarket(data, contractId, evidence));
      // Lighter settles hourly by its docs; the refresher still infers cadence from settled times.
      const native = await context(contractId, call);
      listedAt.set(contractId, native?.listing?.at ?? null);
      return native;
    },
    async page(contractId, range, cursor, call): Promise<HistorySourcePage> {
      const market = markets.get(contractId);
      if (!market) throw new Error('history-market-unmapped');
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start >= range.end
        || range.start % 1_000 || range.end % 1_000) throw new Error('invalid-history-range');
      // Two padding hours: the oldest match the venue may drop is never one the window needs.
      const start = range.start / 1_000 - 2 * HOUR_S;
      const end = cursor === null ? range.end / 1_000 + 1 : Number(cursor);
      if (!Number.isSafeInteger(end) || end <= start || end > range.end / 1_000 + 1) throw new Error('invalid-history-range');
      const url = new URL(`${HOST}${LIGHTER_HISTORY_API}`);
      for (const [key, value] of Object.entries({ market_id: market.marketId, resolution: '1h',
        start_timestamp: start, end_timestamp: end, count_back: 0 })) url.searchParams.set(key, String(value));
      const data: any = await call(`GET ${url}`, (signal) => read('LIGHTER', url.toString(), signal));
      if (data?.code !== 200 || data.resolution !== '1h' || !Array.isArray(data.fundings)
        || data.fundings.some((r: unknown) => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('invalid-history-page');
      let previous: number | null = null;
      const times: number[] = [];
      const rows = (data.fundings as Array<Record<string, unknown>>).map((row): Record<string, unknown> => {
        const t = row.timestamp;
        if (typeof t !== 'number' || !Number.isSafeInteger(t) || t % HOUR_S) throw new Error('invalid-history-time');
        if (t < start || t >= end) throw new Error('history-outside-request');
        if (previous !== null && t <= previous) throw new Error(t === previous ? 'history-duplicate' : 'invalid-history-order');
        if ((row.market_id !== undefined && row.market_id !== market.marketId)
          || (row.market !== undefined && row.market !== contractId)) throw new Error('history-contract-mismatch');
        previous = t;
        times.push(t);
        // Per-market endpoint: the request names the market the rows belong to.
        return { timestamp: t, rate: row.rate, direction: row.direction, value: row.value, market: contractId, market_id: market.marketId };
      });
      if (rows.length > LIMIT) throw new Error('pagination-stalled');
      const oldest = times[0] ?? null;
      // An empty page is the end only beside the listing: the venue drops a lone
      // oldest match, so the listing hour's row is the one that can be missing.
      const listing = listedAt.get(contractId) ?? null;
      if (oldest === null && (listing === null || listing < (end - 2 * HOUR_S) * 1_000)) throw new Error('history-page-empty');
      const done = oldest === null || oldest <= range.start / 1_000;
      return { rows, firstAt: oldest === null ? null : oldest * 1_000,
        lastAt: times.length ? times.at(-1)! * 1_000 : null, done, cursor: done ? null : String(oldest),
        rawHash: createHash('sha256').update(market.evidence).update(JSON.stringify(data)).digest('hex') };
    },
  };
}
