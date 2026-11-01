/**
 * Gate USDT perpetual settled funding history (`GET /futures/usdt/funding_rate`).
 * Probed 2026-11-01: rows are `{ t: seconds, r }`, newest first, with no
 * contract field; `from` is inclusive and `to` exclusive; `limit` is at most
 * 1000; a `from` more than 180 days before the venue's clock is refused; `t`
 * is the settlement hour plus a few seconds of processing delay. Settled-rate
 * evidence: .scratch/funding-gate-lighter-history/evidence/gate-settled-history.md.
 */
import { createHash } from 'node:crypto';
import type { FundingHistorySource, HistoryCall, HistorySourcePage } from './history-collector';
import type { PublicRead } from './official-public';
import { GATE_HISTORY_API, GATE_HISTORY_DAYS } from './history-sources';
import { settlementTimeMapping } from './settlement-time';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIMIT = 1000;
const URL_BASE = `https://api.gateio.ws/api/v4${GATE_HISTORY_API}`;

const seconds = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid-history-time');
  return value;
};

type Context = Awaited<ReturnType<FundingHistorySource['context']>>;

export function gateHistorySource(read: PublicRead, now: () => number,
  context: (contractId: string, call: HistoryCall) => Context | Promise<Context>): FundingHistorySource {
  return {
    venue: 'GATE', api: GATE_HISTORY_API, version: 'official-v1', maxDays: GATE_HISTORY_DAYS,
    // The contract catalog's listing only: Gate's per-contract cadence changes
    // (8h, 4h, 1h) without notice, and today's `funding_interval` does not
    // prove a past one, so the refresher infers cadence from settled times.
    context: async (contractId, call) => context(contractId, call),
    timeMapping: (row) => settlementTimeMapping('GATE', typeof row.t === 'number' ? row.t * 1_000 : row.t),
    async page(contractId, range, cursor, call): Promise<HistorySourcePage> {
      if (!/^[A-Z0-9]+_USDT$/.test(contractId) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
        || range.start >= range.end || range.start % 1_000 || range.end % 1_000) throw new Error('invalid-history-range');
      // The settlement at range.start is outside (start, end], but its record is
      // stamped a few seconds later; the next settlement is no earlier than the next hour.
      const nextHour = Math.floor(range.start / HOUR) * HOUR + HOUR;
      const floor = Math.ceil((now() - GATE_HISTORY_DAYS * DAY) / 1_000) + 60;
      const from = Math.max(range.start / 1_000 + 60, floor);
      const end = range.end / 1_000 + 60;
      const to = cursor === null ? end : Number(cursor);
      if (from > nextHour / 1_000 || !Number.isSafeInteger(to) || to <= from || to > end) throw new Error('invalid-history-range');
      const url = new URL(URL_BASE);
      for (const [key, value] of Object.entries({ contract: contractId, from, to, limit: LIMIT })) url.searchParams.set(key, String(value));
      const data = await call(`GET ${url}`, (signal) => read('GATE', url.toString(), signal));
      if (!Array.isArray(data) || data.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('invalid-history-page');
      // The previous page ended inside this hour: a second record for it is a duplicate too.
      let previous = cursor === null ? null : to;
      const rows = (data as Array<Record<string, unknown>>).map((row) => {
        if (row.contract !== undefined && row.contract !== contractId) throw new Error('history-contract-mismatch');
        const t = seconds(row.t);
        if (t < from || t >= to) throw new Error('history-outside-request');
        // Newest first: the cursor below is only sound when every page is.
        if (previous !== null && t > previous) throw new Error('invalid-history-order');
        if (previous !== null && Math.floor(t / 3_600) === Math.floor(previous / 3_600)) throw new Error('history-duplicate');
        previous = t;
        // Per-contract endpoint: the request names the contract the rows belong to.
        return { contract: contractId, t, r: row.r };
      });
      if (rows.length > LIMIT) throw new Error('pagination-stalled');
      const oldest = rows.at(-1)?.t ?? null;
      // A full page is the newest rows of [from, to): older ones remain unless it reached `from`.
      const done = rows.length < LIMIT || oldest === from;
      return { rows, firstAt: oldest === null ? null : oldest * 1_000, lastAt: rows.length ? rows[0]!.t * 1_000 : null,
        done, cursor: done ? null : String(oldest),
        rawHash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
    },
  };
}
