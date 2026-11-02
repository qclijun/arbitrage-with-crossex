/**
 * Gate's official monthly archive of executed funding (`funding_applies`,
 * https://www.gate.com/developer/historical_quotes) extends REST history past
 * its 180-day limit. Probed 2026-11-02: one gzip CSV per contract and UTC month,
 * `seconds,rate` without a header, published about 02:00 UTC on the next
 * month's first day; rows equal REST's record for record, raw times included.
 * Evidence: .scratch/funding-gate-lighter-history/evidence/gate-archive-history.md.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { snapshotCutoff } from './history';
import type { FundingHistorySource, HistoryCall, HistorySourcePage } from './history-collector';
import type { PublicRead } from './official-public';
import { GATE_ARCHIVE_API, GATE_HISTORY_DAYS } from './history-sources';
import { gateRestFloor, readGateRows, type GateRow } from './gate-history';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const monthAt = (time: number): number => { const d = new Date(time); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth()); };
const previousMonth = (month: number): number => monthAt(month - 1);
const nextMonth = (month: number): number => { const d = new Date(month); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1); };
const monthName = (month: number): string => new Date(month).toISOString().slice(0, 7).replace('-', '');
/** A record's settlement hour in ms: Gate stamps up to a few seconds after it (see settlement-time). */
const hourMs = (t: number): number => Math.floor(t / 3_600) * HOUR;
const archiveUrl = (contractId: string, month: number): string =>
  `https://download.gatedata.org/futures_usdt/funding_applies/${monthName(month)}/${contractId}-${monthName(month)}.csv.gz`;

/** One month's file: non-empty, ascending, one record per settlement hour, every hour inside the month. */
function parseMonth(gz: unknown, contractId: string, month: number): GateRow[] {
  if (!Buffer.isBuffer(gz)) throw new Error('invalid-history-archive');
  let text: string;
  try { text = gunzipSync(gz, { maxOutputLength: 1 << 20 }).toString('utf8'); } catch { throw new Error('invalid-history-archive'); }
  let previous = -1;
  const rows = text.split(/\r?\n/).filter((line) => line !== '').map((line) => {
    const match = /^(\d+),(-?\d+(?:\.\d+)?)$/.exec(line);
    const t = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(t) || t % 3_600 >= 60 || monthAt(hourMs(t)) !== month) throw new Error('invalid-history-csv');
    if (hourMs(t) <= previous) throw new Error(hourMs(t) === previous ? 'history-duplicate' : 'invalid-history-order');
    previous = hourMs(t);
    return { contract: contractId, t, r: match[2] };
  });
  // A month always settles: an empty file is a failed export, not a month without funding.
  if (!rows.length) throw new Error('invalid-history-csv');
  return rows;
}

async function readMonth(read: PublicRead, call: HistoryCall, contractId: string, month: number) {
  const url = archiveUrl(contractId, month);
  const gz = await call(`GET ${url}`, (signal) => read('GATE', url, signal, undefined, 'binary'));
  return { gz: gz as Buffer, rows: parseMonth(gz, contractId, month) };
}

/**
 * Archive and REST must agree record for record from REST's floor through the
 * end of the following month, so every check compares at least one whole month.
 * REST goes first and `month`'s file, if needed, last: the collector files the
 * page under its last request, which is then the page's own file.
 */
async function checkOverlap(read: PublicRead, call: HistoryCall, contractId: string, now: number, month: number) {
  const from = gateRestFloor(now);
  const first = monthAt(from * 1_000);
  const to = nextMonth(nextMonth(first)) / 1_000;
  const served: GateRow[] = [];
  const evidence: unknown[] = [];
  for (let end = to, after: number | null = null; ;) {
    const page = await readGateRows(read, call, contractId, from, end, after);
    served.push(...page.rows);
    evidence.push(page.data);
    const oldest = page.rows.at(-1)?.t;
    if (oldest === undefined || page.rows.length < 1_000 || oldest === from) break;
    end = after = oldest;
  }
  const months = [first, nextMonth(first)].sort((a, b) => Number(a === month) - Number(b === month));
  const files = new Map<number, Awaited<ReturnType<typeof readMonth>>>();
  for (const m of months) files.set(m, await readMonth(read, call, contractId, m));
  const archived = [...files.values()].flatMap((file) => file.rows).filter((row) => row.t >= from && row.t < to);
  const key = (row: GateRow) => `${row.t}:${String(row.r)}`;
  const a = archived.map(key).sort();
  const b = served.map(key).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) throw new Error('history-archive-mismatch');
  for (const file of files.values()) evidence.push(createHash('sha256').update(file.gz).digest('hex'));
  return { evidence, file: files.get(month) };
}

export function withGateArchive(rest: FundingHistorySource, read: PublicRead, now: () => number): FundingHistorySource {
  return {
    ...rest, api: GATE_ARCHIVE_API, version: 'official-archive-v1', maxDays: 365,
    async page(contractId, range, cursor, call): Promise<HistorySourcePage> {
      if (range.end > snapshotCutoff(now()) - GATE_HISTORY_DAYS * DAY) return rest.page(contractId, range, cursor, call);
      if (!/^[A-Z0-9]+_USDT$/.test(contractId) || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
        || range.start >= range.end) throw new Error('invalid-history-range');
      const firstMonth = monthAt(range.start + 1);
      const lastMonth = monthAt(range.end);
      const month = cursor === null ? lastMonth : Number(cursor);
      if (!Number.isSafeInteger(month) || monthAt(month) !== month || month < firstMonth || month > lastMonth
        || (cursor !== null && month === lastMonth)) throw new Error('invalid-history-cursor');
      // Each read of the archive first proves it against REST where both answer.
      const overlap = cursor === null ? await checkOverlap(read, call, contractId, now(), month) : null;
      const { gz, rows: all } = overlap?.file ?? await readMonth(read, call, contractId, month);
      const rows = all.filter((row) => hourMs(row.t) > range.start && hourMs(row.t) <= range.end);
      const done = month === firstMonth;
      return { rows, firstAt: rows.length ? rows[0]!.t * 1_000 : null, lastAt: rows.length ? rows.at(-1)!.t * 1_000 : null,
        cursor: done ? null : String(previousMonth(month)), done,
        rawHash: createHash('sha256').update(gz).update(JSON.stringify(overlap?.evidence ?? null)).digest('hex') };
    },
  };
}
