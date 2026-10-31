import nock from 'nock';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import { normalizeOfficialSettlement } from '../../src/core/funding/history-sources';
import type { HistoryCall } from '../../src/core/funding/history-collector';

const call: HistoryCall = (_request, run) => run(new AbortController().signal);
const start = 1_728_000_000_000;
const event = (fundingTime: number, rateType = 'Regular') => ({ symbol: 'BTCUSDT', fundingTime, fundingRate: '0.0001', rateType });
beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

it('pages Binance with an overlapping boundary so a special settlement is not lost', async () => {
  const source = createOfficialHistorySources().find((s) => s.venue === 'BINANCE')!;
  const end = start + 2_000;
  const first = [...Array.from({ length: 999 }, (_, i) => event(start + i + 1)), event(start + 1_000)];
  nock('https://fapi.binance.com').get('/fapi/v1/fundingRate')
    .query({ symbol: 'BTCUSDT', startTime: start + 1, endTime: end, limit: 1000 }).reply(200, first);
  const page = await source.page('BTCUSDT', { start, end }, null, call);
  expect(page).toMatchObject({ done: false, cursor: String(start + 1_000), firstAt: start + 1, lastAt: start + 1_000 });
  nock('https://fapi.binance.com').get('/fapi/v1/fundingRate')
    .query({ symbol: 'BTCUSDT', startTime: start + 1_000, endTime: end, limit: 1000 })
    .reply(200, [event(start + 1_000), event(start + 1_000, 'Special')]);
  const tail = await source.page('BTCUSDT', { start, end }, page.cursor, call);
  expect(tail.rows.map((r) => r.rateType)).toEqual(['Regular', 'Special']);
  expect(tail.done).toBe(true);
  expect(tail.rawHash).toMatch(/^[a-f0-9]{64}$/);
});

it.each([
  ['ASTER', 'https://fapi.asterdex.com', '/fapi/v3/fundingRate', 1000],
  ['OKX', 'https://www.okx.com', '/api/v5/public/funding-rate-history', 400],
  ['BYBIT', 'https://api.bybit.com', '/v5/market/funding/history', 200],
] as const)('pages %s according to its native direction and terminal response', async (venue, host, path, limit) => {
  const source = createOfficialHistorySources().find((s) => s.venue === venue)!;
  const contractId = venue === 'OKX' ? 'BTC-USDT-SWAP' : 'BTCUSDT';
  const range = { start, end: start + 10_000 };
  const raw = (at: number) => venue === 'OKX'
    ? { instId: contractId, fundingTime: String(at), realizedRate: '0.0002', fundingRate: '9' }
    : venue === 'BYBIT' ? { symbol: contractId, fundingRateTimestamp: String(at), fundingRate: '0.0002' } : event(at);
  const wrap = (rows: unknown[]) => venue === 'OKX' ? { code: '0', data: rows }
    : venue === 'BYBIT' ? { retCode: 0, result: { list: rows } } : rows;
  const rows = Array.from({ length: limit }, (_, i) => raw(start + i + 1));
  const next = venue === 'ASTER' ? start + limit : start + 1;
  nock(host).get(path).query(true).reply(200, wrap(rows));
  const page = await source.page(contractId, range, null, call);
  expect(page).toMatchObject({ done: false, cursor: String(next) });
  nock(host).get(path).query((query) => venue === 'ASTER' ? Number(query.startTime) === next
    : venue === 'OKX' ? Number(query.after) === next : Number(query.endTime) === next)
    .reply(200, wrap(venue === 'OKX' ? [] : [raw(next)]));
  expect(await source.page(contractId, range, page.cursor, call)).toMatchObject({ done: true, cursor: null });
});

it('pages HL on raw milliseconds without claiming that rounding proves settlement time', async () => {
  const source = createOfficialHistorySources().find((s) => s.venue === 'HYPERLIQUID')!;
  const hour = 3_600_000;
  const end = start + 501 * hour;
  const rows = Array.from({ length: 500 }, (_, i) => ({ coin: 'BTC', time: start + (i + 1) * hour + 76, fundingRate: '0.00001' }));
  nock('https://api.hyperliquid.xyz').post('/info', { type: 'fundingHistory', coin: 'BTC', startTime: start + hour, endTime: end + hour - 1 })
    .reply(200, rows);
  const page = await source.page('BTC', { start, end }, null, call);
  expect(page).toMatchObject({ done: false, cursor: String(start + 500 * hour + 76) });
  expect(source.timeMapping?.(rows[0])).toBeUndefined();
  nock('https://api.hyperliquid.xyz').post('/info', { type: 'fundingHistory', coin: 'BTC', startTime: start + 500 * hour + 76, endTime: end + hour - 1 })
    .reply(200, [rows[499]]);
  expect(await source.page('BTC', { start, end }, page.cursor, call)).toMatchObject({ done: true });
});

it('honours Retry-After across rounds and accepts a later read only after cooldown', async () => {
  let now = start;
  const source = createOfficialHistorySources({ now: () => now }).find((s) => s.venue === 'BINANCE')!;
  nock('https://fapi.binance.com').get('/fapi/v1/fundingRate').query(true).reply(429, {}, { 'Retry-After': '120' });
  await expect(source.page('BTCUSDT', { start, end: start + 2_000 }, null, call)).rejects.toMatchObject({ retryAfterMs: 120_000 });
  now += 60_000;
  await expect(source.page('BTCUSDT', { start, end: start + 2_000 }, null, call)).rejects.toMatchObject({ retryAfterMs: 60_000 });
  now += 60_000;
  nock('https://fapi.binance.com').get('/fapi/v1/fundingRate').query(true).reply(200, []);
  expect(await source.page('BTCUSDT', { start, end: start + 2_000 }, null, call)).toMatchObject({ done: true });
});

it('carries only the catalog listing: cadence is proved from the read pages and the current interval, never the source', async () => {
  const context = { listing: { at: start, evidence: 'fixture listing document' } };
  const source = createOfficialHistorySources({ context: async (venue, id) => venue === 'BINANCE' && id === 'BTCUSDT' ? context : null })[0]!;
  expect(await source.context('BTCUSDT', call)).toEqual(context);
  expect(await source.context('ETHUSDT', call)).toBeNull();
});


it('maps an HL delayed cutoff record only with independent timestamp evidence', async () => {
  const hour = 3_600_000;
  const raw = { coin: 'BTC', time: start + hour + 76, fundingRate: '-0.000001' };
  const proof = { settlementAt: start + hour, evidence: 'fixture independent settlement-hour ledger proof' };
  const source = createOfficialHistorySources({ hlSettlements: new Map([[raw.time, proof]]) })
    .find((s) => s.venue === 'HYPERLIQUID')!;
  nock('https://api.hyperliquid.xyz').post('/info', {
    type: 'fundingHistory', coin: 'BTC', startTime: start + hour, endTime: start + 2 * hour - 1,
  }).reply(200, [raw]);
  const page = await source.page('BTC', { start, end: start + hour }, null, call);
  const ref = { venue: source.venue, api: source.api, contractId: 'BTC' };
  expect(normalizeOfficialSettlement(ref, page.rows[0]!, 1, page.rawHash, source.timeMapping?.(raw))).toMatchObject({
    settledAt: start + hour, rawTime: raw.time, timeMappingEvidence: proof.evidence, rate: '-0.000001',
  });
  expect(source.timeMapping?.({ ...raw, time: raw.time + 1 })).toBeUndefined();
});
