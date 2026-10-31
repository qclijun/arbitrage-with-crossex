import nock from 'nock';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { FundingHistoryCache } from '../../src/core/funding/history-cache';
import { createFundingHistoryRefresher, type HistoryCall } from '../../src/core/funding/history-collector';
import { fundingCsvFromZip } from '../../src/core/funding/history-zip';
import { csvZip } from '../helpers/funding-archive-fixture';
import { run } from '../helpers/funding-history-stub';

const H = 3_600_000;
const D = 24 * H;
const cutoff = Date.UTC(2026, 9, 31);
const contractId = 'BTC-USDT-SWAP';
const key = { venue: 'OKX', contractId };
const call: HistoryCall = (_request, run) => run(new AbortController().signal);
const january = Date.UTC(2026, 0, 1) - 8 * H;
const filename = `${contractId}-fundingrates-2026-01.zip`;
const zipUrl = `https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/202601/${filename}`;
const csv = (time: number, rate = '0.0001') => `instrument_name,funding_rate,funding_time\r\n${contractId},${rate},${time}\r\n`;
const manifest = (url = zipUrl) => ({ code: '0', data: [{ dateAggrType: 'monthly', details: [{
  instType: 'SWAP', instFamily: 'BTC-USDT', groupDetails: [{ filename, url }],
}] }] });
beforeEach(() => { nock.disableNetConnect(); vi.stubEnv('GATE_PROXY', ''); });
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('reads the official binary ZIP over the shared public transport with UTC+8 month bounds', async () => {
  const source = createOfficialHistorySources({ now: () => cutoff }).find((s) => s.venue === 'OKX')!;
  nock('https://www.okx.com').get('/api/v5/public/market-data-history')
    .query({ module: '3', instType: 'SWAP', instFamilyList: 'BTC-USDT', dateAggrType: 'monthly', begin: january, end: january })
    .reply(200, manifest());
  nock('https://static.okx.com').get(new URL(zipUrl).pathname)
    .reply(200, csvZip(filename.replace('.zip', '.csv'), csv(january, '1.46168809E-7'), true), { 'Content-Type': 'application/zip' });
  expect(await source.page(contractId, { start: january - 1, end: january }, null, call))
    .toMatchObject({ done: true, rows: [{ instId: contractId, realizedRate: '0.000000146168809', fundingTime: String(january) }] });
  expect(nock.isDone()).toBe(true);
});

it('collects and evaluates all five windows using REST plus archives, preserving exact rates', async () => {
  vi.useFakeTimers({ now: cutoff + 60_000 });
  const requests: string[] = [];
  const sources = createOfficialHistorySources({
    now: Date.now,
    context: () => ({ listing: { at: cutoff - 500 * D, evidence: 'fixture listing' },
      rules: [{ from: cutoff - 500 * D, until: cutoff + H, everyHours: 8, anchor: 0, evidence: 'fixture historical rule' }] }),
    read: async (_venue, rawUrl, _signal, _body, format) => {
      const url = new URL(rawUrl);
      requests.push(rawUrl);
      const rows = (start: number, end: number) => {
        const out: { instId: string; realizedRate: string; fundingTime: string }[] = [];
        for (let t = Math.ceil(start / (8 * H)) * 8 * H; t < end; t += 8 * H) {
          out.push({ instId: contractId, realizedRate: '0.0000000000000001', fundingTime: String(t) });
        }
        return out;
      };
      if (url.pathname.endsWith('funding-rate-history')) {
        const start = Number(url.searchParams.get('before')) + 1;
        const end = Number(url.searchParams.get('after'));
        return { code: '0', data: rows(start, end).reverse().slice(0, 400) };
      }
      if (url.pathname.endsWith('market-data-history')) {
        const files = [];
        for (let month = Number(url.searchParams.get('begin')); month <= Number(url.searchParams.get('end'));) {
          const date = new Date(month + 8 * H);
          const name = date.toISOString().slice(0, 7);
          const filename = `${contractId}-fundingrates-${name}.zip`;
          files.push({ filename, url: `https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/${name.replace('-', '')}/${filename}` });
          month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1) - 8 * H;
        }
        return { code: '0', data: [{ dateAggrType: 'monthly', details: [{ instType: 'SWAP', instFamily: 'BTC-USDT', groupDetails: files }] }] };
      }
      expect(format).toBe('binary');
      const name = url.pathname.split('/').at(-1)!;
      const date = name.match(/(\d{4})-(\d{2})\.zip$/)!;
      const month = Date.UTC(Number(date[1]), Number(date[2]) - 1) - 8 * H;
      const end = Date.UTC(Number(date[1]), Number(date[2])) - 8 * H;
      const text = 'instrument_name,funding_rate,funding_time\r\n'
        + rows(month, end).map((r) => `${r.instId},${r.realizedRate},${r.fundingTime}`).join('\r\n');
      return csvZip(name.replace('.zip', '.csv'), text);
    },
  });
  const cache = new FundingHistoryCache();
  const report = await run(createFundingHistoryRefresher({ cache, sources, legs: async () => [key] }));
  expect(report.venues.OKX, JSON.stringify(cache.snapshot()?.legs.get('OKX\u0000BTC-USDT-SWAP')?.leg.lastAttempt)).toMatchObject({ stopped: null, refreshed: 1 });
  for (const days of [7, 30, 90, 180, 365] as const) {
    expect(cache.evaluate({ underlying: 'BTC', short: key, long: key, days }, Date.now()))
      .toMatchObject({ coverage: 'complete', historyEligible: true, short: { total: `0.${String(days * 3).padStart(16, '0')}`.replace(/0+$/, '') } });
  }
  expect(requests.some((r) => r.includes('market-data-history'))).toBe(true);
  // A per-month manifest wastes the same limited wire budget as a history page.
  // Two range manifests plus monthly downloads leave room for transient retries.
  expect(requests.length).toBeLessThanOrEqual(18);
});

it('does not turn an unavailable monthly file into empty, complete history', async () => {
  const source = createOfficialHistorySources({ now: () => cutoff, read: async () => ({ code: '0', data: [{ dateAggrType: 'monthly', details: [] }] }) })
    .find((s) => s.venue === 'OKX')!;
  await expect(source.page(contractId, { start: january - 1, end: january }, null, call)).rejects.toThrow('history-archive-missing');
});

it('rejects a manifest download outside the exact official funding archive path', async () => {
  const read = vi.fn(async () => manifest('https://example.com/funding.zip'));
  const source = createOfficialHistorySources({ now: () => cutoff, read }).find((s) => s.venue === 'OKX')!;
  await expect(source.page(contractId, { start: january - 1, end: january }, null, call)).rejects.toThrow('invalid-history-download');
  expect(read).toHaveBeenCalledTimes(1);
});

it('rejects corrupt archives and a different entry name', () => {
  const name = filename.replace('.zip', '.csv');
  const zip = csvZip(name, csv(january));
  zip[30 + Buffer.byteLength(name)] ^= 1;
  expect(() => fundingCsvFromZip(zip, name)).toThrow('corrupt-history-zip');
  expect(() => fundingCsvFromZip(csvZip(name, csv(january)), '../bad.csv')).toThrow('unsupported-history-zip');
});
