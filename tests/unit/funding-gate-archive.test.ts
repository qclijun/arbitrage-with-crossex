import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import type { HistoryCall } from '../../src/core/funding/history-collector';
import type { PublicRead } from '../../src/core/funding/official-public';

const H = 3_600_000;
const D = 24 * H;
/** 2026-11-02 00:00 UTC. */
const cutoff = Date.UTC(2026, 10, 2);
const s = (ms: number) => ms / 1_000;
const call: HistoryCall = (_request, run) => run(new AbortController().signal);
const archive = (month: string) => `https://download.gatedata.org/futures_usdt/funding_applies/${month}/BTC_USDT-${month}.csv.gz`;
// Trimmed from funding_applies/202510/BTC_USDT-202510.csv.gz (2026-11-02): no header, seconds and rate.
const csv = (rows: Array<[number, string]>) => gzipSync(rows.map(([t, r]) => `${t},${r}`).join('\n') + '\n');

type Rec = [number, string];
/** Settlements every `step` hours in [from, to), stamped up to 2 s late like Gate's. */
const settle = (from: number, to: number, step = 8): Rec[] => {
  const out: Rec[] = [];
  for (let at = from; at < to; at += step * H) out.push([s(at) + (at / H) % 3, at % (24 * H) ? '0.0001' : '-0.00002']);
  return out;
};
/** Each month's file from the same settlements REST serves. */
const files = (rows: Rec[], months: string[]) => Object.fromEntries(months.map((m) => [archive(m), csv(rows.filter(([t]) => {
  const d = new Date(t * 1_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}` === m;
}))]));
/** Gate REST over `rows`: [from, to), newest 1000 first. */
const serve = (rows: Rec[]) => (url: URL) => {
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  return rows.filter(([t]) => t >= from && t < to).map(([t, r]) => ({ r, t })).reverse().slice(0, 1_000);
};
// REST's floor is 2026-05-06; archive and REST must agree from it through June.
const floor = s(cutoff + 60_000 - 180 * D) + 60;
const overlapRows = settle(Date.UTC(2026, 4), Date.UTC(2026, 6));
const overlap = files(overlapRows, ['202605', '202606']);

function source(archived: Record<string, Buffer>, rest: (url: URL) => unknown = serve(overlapRows)) {
  const requests: string[] = [];
  const read: PublicRead = async (_venue, url, _signal, _body, format) => {
    requests.push(url);
    if (url.startsWith('https://download.gatedata.org/')) {
      expect(format).toBe('binary');
      if (!archived[url]) throw new Error('official-http-404');
      return archived[url];
    }
    return rest(new URL(url));
  };
  // The collector files a page under its last request: the label of the last call.
  const labels: string[] = [];
  const traced: HistoryCall = (request, run) => { labels.push(request); return call(request, run); };
  return { requests, labels, traced, gate: createOfficialHistorySources({ read, now: () => cutoff + 60_000 }).find((x) => x.venue === 'GATE')! };
}

it('reads the year beyond REST from Gate\'s monthly executed-funding archive, newest month first', async () => {
  const range = { start: Date.UTC(2025, 10, 30, 16), end: Date.UTC(2026, 0, 1, 8) };
  const { gate, requests, labels, traced } = source({ ...overlap,
    [archive('202601')]: csv([[s(Date.UTC(2026, 0, 1)) + 1, '0.0001'], [s(Date.UTC(2026, 0, 1, 8)), '-0.000008'], [s(Date.UTC(2026, 0, 1, 16)), '0']]),
    [archive('202512')]: csv([[s(Date.UTC(2025, 11, 1)), '0.00002']]),
    [archive('202511')]: csv([[s(Date.UTC(2025, 10, 30, 16)) + 2, '0.00003'], [s(Date.UTC(2025, 10, 30, 23)), '0.00004']]),
  });
  const first = await gate.page('BTC_USDT', range, null, traced);
  expect(first).toMatchObject({ done: false, cursor: String(Date.UTC(2025, 11)),
    rows: [{ contract: 'BTC_USDT', t: s(Date.UTC(2026, 0, 1)) + 1, r: '0.0001' }, { contract: 'BTC_USDT', t: s(Date.UTC(2026, 0, 1, 8)), r: '-0.000008' }] });
  // The overlap check comes first, so the page is filed under its own month's file.
  expect(labels.at(-1)).toBe(`GET ${archive('202601')}`);
  const second = await gate.page('BTC_USDT', range, first.cursor, call);
  expect(second).toMatchObject({ done: false, rows: [{ t: s(Date.UTC(2025, 11, 1)), r: '0.00002' }] });
  // The window start's own (delayed) record is outside (start, end].
  expect(await gate.page('BTC_USDT', range, second.cursor, call)).toMatchObject({ done: true, cursor: null,
    rows: [{ t: s(Date.UTC(2025, 10, 30, 23)), r: '0.00004' }] });
  expect(requests).toEqual([expect.stringContaining(`from=${floor}&to=${s(Date.UTC(2026, 6))}`),
    archive('202605'), archive('202606'), archive('202601'), archive('202512'), archive('202511')]);
});

describe('the overlap with REST', () => {
  // The 365-day segment ends at cutoff - 180 days (2026-05-06), in May.
  const range = { start: cutoff - 365 * D, end: cutoff - 180 * D };
  type Out = Array<{ r: string; t: number }>;

  it('compares a whole month after REST\'s floor, then reads only the window', async () => {
    const { gate, requests } = source(overlap);
    const page = await gate.page('BTC_USDT', range, null, call);
    // May is both the page's month and part of the overlap: read once, last.
    expect(requests.map((u) => u.includes('api.gateio.ws') ? 'rest' : u.split('/')[5])).toEqual(['rest', '202606', '202605']);
    expect(page.rows.every((row) => (row.t as number) * 1_000 <= range.end + 59_000)).toBe(true);
    expect(page.rows).toHaveLength(16);
  });

  it('pages REST through an hourly overlap of more than 1000 records', async () => {
    const hourly = settle(Date.UTC(2026, 4), Date.UTC(2026, 6), 1);
    const { gate, requests } = source(files(hourly, ['202605', '202606']), serve(hourly));
    await gate.page('BTC_USDT', range, null, call);
    expect(requests.filter((u) => u.includes('api.gateio.ws'))).toHaveLength(2);
  });

  it.each([
    ['a different rate', (out: Out) => [{ ...out[0]!, r: '0.0002' }, ...out.slice(1)]],
    ['a record the archive lacks', (out: Out) => [{ r: '0.0001', t: out[0]!.t + 4 * 3_600 }, ...out]],
    ['a record REST lacks', (out: Out) => out.slice(1)],
    ['another processing second', (out: Out) => [{ ...out[0]!, t: out[0]!.t + 1 }, ...out.slice(1)]],
    ['nothing', () => []],
  ])('fails when REST shows %s', async (_name, change) => {
    const { gate } = source(overlap, (url) => change(serve(overlapRows)(url)));
    await expect(gate.page('BTC_USDT', range, null, call)).rejects.toThrow('history-archive-mismatch');
  });

  it('checks once per read: a resumed page does not repeat it', async () => {
    const { gate, requests } = source({ ...overlap, ...files(settle(Date.UTC(2026, 3), Date.UTC(2026, 4)), ['202604']) });
    await gate.page('BTC_USDT', range, String(Date.UTC(2026, 3)), call);
    expect(requests).toEqual([archive('202604')]);
  });

  it.each([
    ['not a month start', String(Date.UTC(2026, 3, 2))],
    ['the first page\'s month', String(Date.UTC(2026, 4))],
    ['a month before the window', String(Date.UTC(2025, 9))],
    ['not a number', 'x'],
  ])('rejects a cursor that is %s', async (_name, cursor) => {
    const { gate } = source(overlap);
    await expect(gate.page('BTC_USDT', range, cursor, call)).rejects.toThrow('invalid-history-cursor');
  });
});

it.each([
  ['a header line', gzipSync('timestamp,rate\n1767225600,0.0001\n'), 'invalid-history-csv'],
  ['a record from another month', csv([[s(Date.UTC(2025, 11, 31, 16)), '0.0001']]), 'invalid-history-csv'],
  ['an off-hour record', csv([[s(Date.UTC(2026, 0, 1)) + 60, '0.0001']]), 'invalid-history-csv'],
  ['an exponent rate', csv([[s(Date.UTC(2026, 0, 1)), '1E-7']]), 'invalid-history-csv'],
  ['two records for one hour', csv([[s(Date.UTC(2026, 0, 1)), '0.0001'], [s(Date.UTC(2026, 0, 1)) + 2, '0.0001']]), 'history-duplicate'],
  ['descending records', csv([[s(Date.UTC(2026, 0, 1, 8)), '0.0001'], [s(Date.UTC(2026, 0, 1)), '0.0001']]), 'invalid-history-order'],
  ['a file that is not gzip', Buffer.from('1767225600,0.0001\n'), 'invalid-history-archive'],
  ['no records', gzipSync(''), 'invalid-history-csv'],
] as const)('rejects an archive with %s', async (_name, file, error) => {
  const { gate } = source({ ...overlap, [archive('202601')]: file as Buffer });
  await expect(gate.page('BTC_USDT', { start: Date.UTC(2025, 11, 31, 16), end: Date.UTC(2026, 0, 2) }, null, call)).rejects.toThrow(error);
});

it('fails a month the archive has not published rather than reading it as empty', async () => {
  const { gate } = source(overlap);
  await expect(gate.page('BTC_USDT', { start: Date.UTC(2025, 11, 31, 16), end: Date.UTC(2026, 0, 2) }, null, call)).rejects.toThrow('official-http-404');
});

it('keeps REST for every window REST can serve', async () => {
  const { gate, requests } = source({});
  await gate.page('BTC_USDT', { start: cutoff - 180 * D, end: cutoff - 90 * D }, null, call);
  expect(requests).toEqual([expect.stringContaining('api.gateio.ws')]);
});
