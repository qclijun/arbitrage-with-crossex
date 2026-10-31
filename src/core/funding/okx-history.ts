/** Official monthly funding archives extend REST history beyond three months. */
import { createHash } from 'node:crypto';
import type { FundingHistorySource, HistorySourcePage } from './history-collector';
import type { PublicRead } from './official-public';
import { OKX_ARCHIVE_API } from './history-sources';
import { fundingCsvFromZip } from './history-zip';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SHANGHAI = 8 * HOUR;

/** Archive month/date query parameters are interpreted in UTC+8 by OKX. */
function monthAt(time: number): number {
  const date = new Date(time + SHANGHAI);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth()) - SHANGHAI;
}
function previousMonth(month: number): number { return monthAt(month - 1); }
function monthName(month: number): string { return new Date(month + SHANGHAI).toISOString().slice(0, 7); }

/** Official CSV sometimes writes tiny rates as e.g. 1.46168809E-7. Expand as text. */
function decimalText(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || value.length > 1_024) throw new Error('invalid-history-rate');
  if (match[4] === undefined) return value;
  const exponent = Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) throw new Error('invalid-history-rate');
  const digits = match[2]! + (match[3] ?? '');
  const point = match[2]!.length + exponent;
  const plain = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return match[1] + plain;
}

function parseCsv(text: string, contractId: string, month: number): Record<string, unknown>[] {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.shift() !== 'instrument_name,funding_rate,funding_time' || !lines.length) throw new Error('invalid-history-csv');
  return lines.map((line) => {
    const cells = line.split(',');
    const [instId, realizedRate, fundingTime] = cells;
    if (cells.length !== 3 || instId !== contractId
      || !/^\d+$/.test(fundingTime!) || !Number.isSafeInteger(Number(fundingTime))
      || monthAt(Number(fundingTime)) !== month) throw new Error('invalid-history-csv');
    return { instId, realizedRate: decimalText(realizedRate!), fundingTime };
  });
}

export function withOkxArchive(rest: FundingHistorySource, read: PublicRead, now: () => number): FundingHistorySource {
  // A manifest can list up to ten inclusive months. Reuse only its file index
  // within the current cutoff; every ZIP still gets a fresh, budgeted read.
  const manifests = new Map<string, Promise<any>>();
  let manifestCutoff = -1;
  return {
    ...rest, api: OKX_ARCHIVE_API, version: 'official-archive-v1', maxDays: 365,
    async page(contractId, range, cursor, call): Promise<HistorySourcePage> {
      if (range.end > Math.floor(now() / HOUR) * HOUR - 90 * DAY) return rest.page(contractId, range, cursor, call);
      if (!/^[A-Z0-9]+-USDT-SWAP$/.test(contractId) || !Number.isSafeInteger(range.start)
        || !Number.isSafeInteger(range.end) || range.start >= range.end) throw new Error('invalid-history-range');
      const firstMonth = monthAt(range.start + 1);
      const lastMonth = monthAt(range.end);
      const month = cursor === null ? lastMonth : Number(cursor);
      if (!Number.isSafeInteger(month) || monthAt(month) !== month || month < firstMonth || month > lastMonth
        || (cursor !== null && month === lastMonth)) throw new Error('invalid-history-cursor');
      const name = monthName(month);
      const family = contractId.slice(0, -5);
      const filename = `${contractId}-fundingrates-${name}.zip`;
      const cutoff = Math.floor(now() / HOUR) * HOUR;
      if (manifestCutoff !== cutoff) { manifests.clear(); manifestCutoff = cutoff; }
      let batchEnd = lastMonth;
      let batchStart = batchEnd;
      for (;;) {
        batchStart = batchEnd;
        for (let i = 1; i < 10 && batchStart > firstMonth; i += 1) batchStart = previousMonth(batchStart);
        if (month >= batchStart) break;
        batchEnd = previousMonth(batchStart);
      }
      const url = new URL('https://www.okx.com/api/v5/public/market-data-history');
      for (const [key, value] of Object.entries({ module: '3', instType: 'SWAP', instFamilyList: family,
        dateAggrType: 'monthly', begin: String(batchStart), end: String(batchEnd) })) url.searchParams.set(key, value);
      const cacheKey = url.toString();
      let pending = manifests.get(cacheKey);
      if (!pending) {
        if (manifests.size >= 32) manifests.delete(manifests.keys().next().value!);
        pending = call(`GET ${url}`, (signal) => read('OKX', url.toString(), signal));
        manifests.set(cacheKey, pending);
      }
      let manifest: any;
      try { manifest = await pending; } catch (error) { manifests.delete(cacheKey); throw error; }
      try {
        if (manifest?.code !== '0' || !Array.isArray(manifest.data)) throw new Error('invalid-history-manifest');
        const groups = manifest.data.flatMap((group: any) => {
          if (group.dateAggrType !== 'monthly' || !Array.isArray(group.details)) throw new Error('invalid-history-manifest');
          return group.details.filter((detail: any) => detail.instFamily === family && detail.instType === 'SWAP');
        });
        const files = groups.flatMap((group: any) => {
          if (!Array.isArray(group.groupDetails)) throw new Error('invalid-history-manifest');
          return group.groupDetails.filter((file: any) => file.filename === filename);
        });
        if (files.length !== 1 || typeof files[0].url !== 'string') throw new Error('history-archive-missing');
        const download = new URL(files[0].url);
        const path = `/cdn/okex/traderecords/swaprates/monthly/${name.replace('-', '')}/${filename}`;
        if (download.protocol !== 'https:' || download.hostname !== 'static.okx.com' || download.port
          || download.username || download.password || download.pathname !== path) throw new Error('invalid-history-download');
        const zip = await call(`GET ${download}`, (signal) => read('OKX', download.toString(), signal, undefined, 'binary'));
        const rows = parseCsv(fundingCsvFromZip(zip, filename.replace(/\.zip$/, '.csv')), contractId, month)
          .filter((row) => Number(row.fundingTime) > range.start && Number(row.fundingTime) <= range.end);
        const times = rows.map((row) => Number(row.fundingTime));
        const done = month === firstMonth;
        return { rows, firstAt: times.length ? Math.min(...times) : null, lastAt: times.length ? Math.max(...times) : null,
          cursor: done ? null : String(previousMonth(month)), done,
          rawHash: createHash('sha256').update(JSON.stringify(manifest)).update(zip as Buffer).digest('hex') };
      } catch (error) { manifests.delete(cacheKey); throw error; }
    },
  };
}
