import nock from 'nock';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import type { HistoryCall } from '../../src/core/funding/history-collector';
import { normalizeOfficialSettlement } from '../../src/core/funding/history-sources';
import { parseLighter } from '../../src/core/funding/feeds';

const H = 3_600_000;
const D = 24 * H;
/** 2026-11-02 00:00 UTC. */
const cutoff = Date.UTC(2026, 10, 2);
const s = (ms: number) => ms / 1_000;
const call: HistoryCall = (_request, run) => run(new AbortController().signal);
const host = 'https://mainnet.zklighter.elliot.ai';
const listing = { at: 1_737_098_461_107, evidence: 'GET /api/v1/orderBooks#fixture created_at' };
const lighter = () => createOfficialHistorySources({ now: () => cutoff + 60_000,
  context: (venue) => (venue === 'LIGHTER' ? { listing, rules: [] } : null) }).find((x) => x.venue === 'LIGHTER')!;
// Trimmed from GET /api/v1/orderBooks (2026-11-02): a spot book shares the ETH name.
const books = { code: 200, order_books: [
  { symbol: 'ETH', market_id: 0, market_type: 'perp', status: 'active', is_frozen: false },
  { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', is_frozen: false },
  { symbol: 'ETH/USDC', market_id: 2048, market_type: 'spot', status: 'active', is_frozen: false },
] };
const row = (at: number, rate = '0.0012', direction = 'long') => ({ timestamp: s(at), value: '0.93354960', rate, direction });
beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

it('maps BTC to its perp market and reads hourly fundings with two hours of padding before the window', async () => {
  const source = lighter();
  nock(host).get('/api/v1/orderBooks').reply(200, books);
  expect(await source.context('BTC', call)).toEqual({ listing, rules: [] });
  const range = { start: cutoff - 30 * D, end: cutoff };
  nock(host).get('/api/v1/fundings').query({ market_id: 1, resolution: '1h', start_timestamp: s(range.start - 2 * H),
    end_timestamp: s(range.end) + 1, count_back: 0 }).reply(200, { code: 200, resolution: '1h',
    fundings: [row(range.start - H), row(range.start), row(cutoff, '0.0003', 'short')] });
  const page = await source.page('BTC', range, null, call);
  expect(page).toMatchObject({ done: true, cursor: null, firstAt: range.start - H, lastAt: cutoff });
  expect(page.rows.at(-1)).toMatchObject({ market: 'BTC', market_id: 1, timestamp: s(cutoff), rate: '0.0003', direction: 'short' });
});

it.each([
  ['0.0012', 'long', '0.000012'],
  ['0.0003', 'short', '-0.000003'],
  ['0.0000', 'short', '0'],
  ['0.0000', 'long', '0'],
  ['0.5000', 'long', '0.005'],
])('stores %s percent (%s) as the hourly fraction %s, the same unit as the current rate', (rate, direction, fraction) => {
  const ref = { venue: 'LIGHTER', api: lighter().api, contractId: 'BTC' };
  const raw = { ...row(cutoff, rate, direction), market: 'BTC', market_id: 1 };
  expect(normalizeOfficialSettlement(ref, raw, 1, 'req#hash')).toMatchObject({
    settledAt: cutoff, rate: fraction, intervalHours: 1, status: 'settled', kind: 'regular' });
});

it.each([
  ['another market', { market: 'ETH' }],
  ['a signed rate', { rate: '-0.0012' }],
  ['an unknown direction', { direction: 'both' }],
  ['a numeric rate', { rate: 0.0012 }],
  ['a millisecond timestamp', { timestamp: cutoff }],
])('does not normalize %s', (_name, change) => {
  const ref = { venue: 'LIGHTER', api: lighter().api, contractId: 'BTC' };
  expect(normalizeOfficialSettlement(ref, { ...row(cutoff), market: 'BTC', market_id: 1, ...change }, 1, 'e')).toBeNull();
});

it('pages back from the oldest row, so a match the venue drops is read on the next page', async () => {
  const source = lighter();
  nock(host).get('/api/v1/orderBooks').reply(200, books);
  await source.context('ETH', call);
  const range = { start: cutoff - 90 * D, end: cutoff - 30 * D };
  // 1440 hours match; the venue keeps the newest 750 and drops their oldest.
  const first = Array.from({ length: 749 }, (_, i) => row(range.end - (748 - i) * H));
  nock(host).get('/api/v1/fundings').query((q) => q.market_id === '0' && Number(q.end_timestamp) === s(range.end) + 1)
    .reply(200, { code: 200, resolution: '1h', fundings: first });
  const page = await source.page('ETH', range, null, call);
  expect(page).toMatchObject({ done: false, cursor: String(s(range.end - 748 * H)) });
  const rest = Array.from({ length: 693 }, (_, i) => row(range.start - H + i * H));
  nock(host).get('/api/v1/fundings').query((q) => Number(q.end_timestamp) === s(range.end - 748 * H))
    .reply(200, { code: 200, resolution: '1h', fundings: rest });
  const tail = await source.page('ETH', range, page.cursor, call);
  expect(tail).toMatchObject({ done: true, cursor: null });
  expect(tail.rows.at(-1)).toMatchObject({ timestamp: s(range.end - 749 * H) });
});

it.each([
  ['a duplicate hour', [row(cutoff - H), row(cutoff - H)], 'history-duplicate'],
  ['newest-first rows', [row(cutoff), row(cutoff - H)], 'invalid-history-order'],
  ['an off-hour timestamp', [row(cutoff - H + 1_000)], 'invalid-history-time'],
  ['a row past the requested end', [row(cutoff + H)], 'history-outside-request'],
  ['a row before the padded start', [row(cutoff - 7 * D - 3 * H)], 'history-outside-request'],
  ['a row naming another market', [{ ...row(cutoff), market_id: 0 }], 'history-contract-mismatch'],
  ['an empty page for a market listed long before the window', [], 'history-page-empty'],
] as const)('rejects %s', async (_name, fundings, error) => {
  const source = lighter();
  nock(host).get('/api/v1/orderBooks').reply(200, books);
  await source.context('BTC', call);
  nock(host).get('/api/v1/fundings').query(true).reply(200, { code: 200, resolution: '1h', fundings });
  await expect(source.page('BTC', { start: cutoff - 7 * D, end: cutoff }, null, call)).rejects.toThrow(error);
});

it('refuses a contract without exactly one perp book, and reads no fundings before mapping', async () => {
  const source = lighter();
  await expect(source.page('BTC', { start: cutoff - 7 * D, end: cutoff }, null, call)).rejects.toThrow('history-market-unmapped');
  nock(host).get('/api/v1/orderBooks').reply(200, { ...books, order_books: [...books.order_books,
    { symbol: 'BTC', market_id: 7, market_type: 'perp', status: 'active', is_frozen: false }] });
  await expect(source.context('BTC', call)).rejects.toThrow('history-market-unmapped');
  await expect(source.context('ETH/USDC', call)).rejects.toThrow('history-market-unmapped');
  await expect(source.context('SOL', call)).rejects.toThrow('history-market-unmapped');
});

it('ends at an empty page only where the listing proves nothing older settled', async () => {
  const fresh = { at: cutoff - 3 * D - 30 * 60_000, evidence: 'fixture listing' };
  const source = createOfficialHistorySources({ now: () => cutoff + 60_000,
    context: () => ({ listing: fresh, rules: [] }) }).find((x) => x.venue === 'LIGHTER')!;
  nock(host).get('/api/v1/orderBooks').reply(200, books);
  await source.context('BTC', call);
  // The venue dropped the listing hour's row, the oldest match, from the previous page.
  const cursor = String(s(cutoff - 3 * D + H));
  nock(host).get('/api/v1/fundings').query(true).reply(200, { code: 200, resolution: '1h', fundings: [] });
  expect(await source.page('BTC', { start: cutoff - 7 * D, end: cutoff }, cursor, call)).toMatchObject({ done: true });
});

it('does not keep an order-book error for the hour', async () => {
  const source = lighter();
  nock(host).get('/api/v1/orderBooks').reply(200, { code: 500, message: 'busy' });
  await expect(source.context('BTC', call)).rejects.toThrow('invalid-instrument-response');
  nock(host).get('/api/v1/orderBooks').reply(200, books);
  expect(await source.context('BTC', call)).toEqual({ listing, rules: [] });
});

it('fails an API error rather than reading it as empty history', async () => {
  const source = lighter();
  nock(host).get('/api/v1/orderBooks').reply(200, books);
  await source.context('BTC', call);
  nock(host).get('/api/v1/fundings').query(true).reply(200, { code: 21619, message: 'invalid market type' });
  await expect(source.page('BTC', { start: cutoff - 7 * D, end: cutoff }, null, call)).rejects.toThrow('invalid-history-page');
});

it('puts the settled hourly rate in the unit of the current rate, so their annualized figures compare directly', () => {
  // 2026-11-02 00:39Z: the feed's BTC 8-hour equivalent, and the 00:00Z settlement it matched.
  const [current] = parseLighter({ funding_rates: [{ market_id: 1, exchange: 'lighter', symbol: 'BTC', rate: 9.599999999999999e-05 }] });
  const ref = { venue: 'LIGHTER', api: lighter().api, contractId: 'BTC' };
  const settled = normalizeOfficialSettlement(ref, { ...row(cutoff), market: 'BTC', market_id: 1 }, 1, 'e')!;
  // The feed writes a float; equal up to that float's own error, at the same 1-hour interval.
  expect(settled).toMatchObject({ rate: '0.000012', intervalHours: current!.intervalHours });
  expect(Math.abs(current!.rate - Number(settled.rate))).toBeLessThan(1e-18);
});
