import { expect, it } from 'vitest';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import type { HistoryCall } from '../../src/core/funding/history-collector';
import { csvZip } from '../helpers/funding-archive-fixture';

const H = 3_600_000;
const month = (year: number, index: number) => Date.UTC(year, index) - 8 * H;
const call: HistoryCall = (_request, run) => run(new AbortController().signal);
const contract = 'BTC-USDT-SWAP';

function fixture() {
  let now = Date.UTC(2026, 9, 31);
  let fail = false;
  const manifests: URL[] = [];
  const downloads: string[] = [];
  const source = createOfficialHistorySources({ now: () => now, read: async (_venue, rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('market-data-history')) {
      manifests.push(url);
      if (fail) { fail = false; throw new Error('transient'); }
      const files = [];
      for (let time = Number(url.searchParams.get('begin')); time <= Number(url.searchParams.get('end'));) {
        const date = new Date(time + 8 * H);
        const name = date.toISOString().slice(0, 7);
        const filename = `${contract}-fundingrates-${name}.zip`;
        files.push({ filename, url: `https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/${name.replace('-', '')}/${filename}` });
        time = month(date.getUTCFullYear(), date.getUTCMonth() + 1);
      }
      return { code: '0', data: [{ dateAggrType: 'monthly', details: [{ instFamily: 'BTC-USDT', instType: 'SWAP', groupDetails: files }] }] };
    }
    downloads.push(rawUrl);
    const name = url.pathname.split('/').at(-1)!.replace('.zip', '.csv');
    const date = name.match(/(\d{4})-(\d{2})\.csv$/)!;
    const time = month(Number(date[1]), Number(date[2]) - 1);
    return csvZip(name, `instrument_name,funding_rate,funding_time\n${contract},0.0001,${time}\n`);
  } }).find((s) => s.venue === 'OKX')!;
  return { source, manifests, downloads, nextHour: () => { now += H; }, fail: () => { fail = true; } };
}

it('batches at most ten inclusive months and fetches every monthly ZIP with its own evidence', async () => {
  const f = fixture();
  const range = { start: month(2024, 0) - 1, end: month(2025, 0) };
  let cursor: string | null = null;
  for (let i = 0; i < 13; i += 1) {
    const page = await f.source.page(contract, range, cursor, call);
    expect(page.rawHash).toMatch(/^[0-9a-f]{64}$/);
    expect(page.done).toBe(i === 12);
    cursor = page.cursor;
  }
  expect(f.manifests).toHaveLength(2);
  expect(new Set(f.downloads).size).toBe(13);
  for (const url of f.manifests) {
    const begin = new Date(Number(url.searchParams.get('begin')) + 8 * H);
    const end = new Date(Number(url.searchParams.get('end')) + 8 * H);
    expect((end.getUTCFullYear() - begin.getUTCFullYear()) * 12 + end.getUTCMonth() - begin.getUTCMonth()).toBeLessThan(10);
  }
});

it('refreshes the manifest at the next cutoff and does not cache a failed request', async () => {
  const f = fixture();
  const range = { start: month(2026, 0) - 1, end: month(2026, 0) };
  f.fail();
  await expect(f.source.page(contract, range, null, call)).rejects.toThrow('transient');
  await f.source.page(contract, range, null, call);
  await f.source.page(contract, range, null, call);
  expect(f.manifests).toHaveLength(2);
  expect(f.downloads).toHaveLength(2);
  f.nextHour();
  await f.source.page(contract, range, null, call);
  expect(f.manifests).toHaveLength(3);
  expect(f.downloads).toHaveLength(3);
});
