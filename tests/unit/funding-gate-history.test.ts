import nock from 'nock';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOfficialHistorySources } from '../../src/core/funding/official-history';
import type { HistoryCall } from '../../src/core/funding/history-collector';
import { normalizeOfficialSettlement } from '../../src/core/funding/history-sources';

const H = 3_600_000;
const D = 24 * H;
/** 2026-11-01 16:00 UTC, an 8-hour settlement. */
const cutoff = Date.UTC(2026, 10, 1, 16);
const s = (ms: number) => ms / 1_000;
const call: HistoryCall = (_request, run) => run(new AbortController().signal);
const gate = (now = cutoff + 2 * 60_000) => createOfficialHistorySources({ now: () => now }).find((x) => x.venue === 'GATE')!;
const host = 'https://api.gateio.ws';
const path = '/api/v4/futures/usdt/funding_rate';
beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

it('reads Gate history newest first in seconds, skipping the window start settlement and its processing delay', async () => {
  const range = { start: cutoff - 7 * D, end: cutoff };
  // Gate's `from` is inclusive and `to` exclusive (probed 2026-11-01).
  nock(host).get(path).query({ contract: 'BTC_USDT', from: s(range.start) + 60, to: s(range.end) + 60, limit: 1000 })
    .reply(200, [{ r: '0.0001', t: s(cutoff) + 2 }, { r: '-0.000008', t: s(cutoff - 8 * H) }]);
  const page = await gate().page('BTC_USDT', range, null, call);
  expect(page).toMatchObject({ done: true, cursor: null, firstAt: cutoff - 8 * H, lastAt: cutoff + 2_000,
    rows: [{ contract: 'BTC_USDT', t: s(cutoff) + 2, r: '0.0001' }, { contract: 'BTC_USDT', t: s(cutoff - 8 * H), r: '-0.000008' }] });
  expect(page.rawHash).toMatch(/^[a-f0-9]{64}$/);
});

it('pages a full 1000-row response back from its oldest row and starts the 180-day segment inside Gate\'s limit', async () => {
  const now = cutoff + 50 * 60_000;
  const range = { start: cutoff - 180 * D, end: cutoff };
  const floor = s(now - 180 * D) + 60;
  const rows = Array.from({ length: 1000 }, (_, i) => ({ r: '0.00001', t: s(cutoff - i * H) + 1 }));
  nock(host).get(path).query({ contract: 'ETH_USDT', from: floor, to: s(cutoff) + 60, limit: 1000 }).reply(200, rows);
  const page = await gate(now).page('ETH_USDT', range, null, call);
  const oldest = s(cutoff - 999 * H) + 1;
  expect(page).toMatchObject({ done: false, cursor: String(oldest) });
  nock(host).get(path).query({ contract: 'ETH_USDT', from: floor, to: oldest, limit: 1000 })
    .reply(200, [{ r: '0', t: oldest - 3_600 }]);
  expect(await gate(now).page('ETH_USDT', range, page.cursor, call)).toMatchObject({ done: true, cursor: null });
  // No hour lies between the window start and Gate's floor, so no settlement is skipped.
  expect(floor * 1_000).toBeLessThan(range.start + H);
});

it.each([
  ['a row for another contract', [{ contract: 'ETH_USDT', r: '0.0001', t: s(cutoff) }], 'history-contract-mismatch'],
  ['a repeated timestamp', [{ r: '0.0001', t: s(cutoff) }, { r: '0.0001', t: s(cutoff) }], 'history-duplicate'],
  ['two records for one settlement hour', [{ r: '0.0001', t: s(cutoff) + 3 }, { r: '0.0002', t: s(cutoff) }], 'history-duplicate'],
  ['a row past the requested end', [{ r: '0.0001', t: s(cutoff) + 60 }], 'history-outside-request'],
  ['a row before the requested start', [{ r: '0.0001', t: s(cutoff - 7 * D) }], 'history-outside-request'],
  ['a millisecond timestamp', [{ r: '0.0001', t: cutoff }], 'history-outside-request'],
  ['a string timestamp', [{ r: '0.0001', t: String(s(cutoff)) }], 'invalid-history-time'],
  ['an error object', { label: 'INVALID_PARAM_VALUE' }, 'invalid-history-page'],
  ['oldest-first rows', [{ r: '0.0001', t: s(cutoff - 8 * H) }, { r: '0.0001', t: s(cutoff) }], 'invalid-history-order'],
] as const)('rejects %s rather than accepting it silently', async (_name, body, error) => {
  nock(host).get(path).query(true).reply(200, body as object);
  await expect(gate().page('BTC_USDT', { start: cutoff - 7 * D, end: cutoff }, null, call)).rejects.toThrow(error);
});

it('rejects a second record for the hour a full page ended on, when it lands on the next page', async () => {
  const range = { start: cutoff - 90 * D, end: cutoff };
  const oldest = s(cutoff - 999 * H) + 2;
  nock(host).get(path).query(true).reply(200, Array.from({ length: 1000 }, (_, i) => ({ r: '0.00001', t: i === 999 ? oldest : s(cutoff - i * H) })));
  const page = await gate().page('BTC_USDT', range, null, call);
  nock(host).get(path).query((q) => Number(q.to) === oldest).reply(200, [{ r: '0.00001', t: oldest - 2 }]);
  await expect(gate().page('BTC_USDT', range, page.cursor, call)).rejects.toThrow('history-duplicate');
});

it('fails an unknown contract or a request beyond Gate\'s 180-day limit', async () => {
  nock(host).get(path).query(true).reply(400, { label: 'CONTRACT_NOT_FOUND' });
  await expect(gate().page('FOO_USDT', { start: cutoff - 7 * D, end: cutoff }, null, call)).rejects.toThrow('official-http-400');
  await expect(gate().page('BTC_USDT', { start: cutoff - 181 * D, end: cutoff }, null, call)).rejects.toThrow('invalid-history-range');
  await expect(gate().page('BTC-USDT-SWAP', { start: cutoff - 7 * D, end: cutoff }, null, call)).rejects.toThrow('invalid-history-range');
});

it('normalizes a delayed Gate record to its settlement hour, keeping the raw time and mapping evidence', () => {
  const source = gate();
  const row = { contract: 'BTC_USDT', t: s(cutoff) + 5, r: '-0.000021' };
  const ref = { venue: 'GATE', api: source.api, contractId: 'BTC_USDT' };
  expect(normalizeOfficialSettlement(ref, row, 8, 'req#hash', source.timeMapping?.(row))).toMatchObject({
    settledAt: cutoff, rawTime: cutoff + 5_000, rate: '-0.000021', intervalHours: 8, status: 'settled', evidence: 'req#hash',
    timeMappingEvidence: expect.stringContaining('gate.com'),
  });
  expect(normalizeOfficialSettlement(ref, { ...row, t: s(cutoff) }, null, 'e')).toMatchObject({ settledAt: cutoff, rate: '-0.000021' });
  // A minute late is no longer a processing delay, and another contract is never this one.
  const late = { ...row, t: s(cutoff) + 60 };
  expect(source.timeMapping?.(late)).toBeUndefined();
  expect(normalizeOfficialSettlement(ref, late, 8, 'e', source.timeMapping?.(late))).toBeNull();
  expect(normalizeOfficialSettlement(ref, { ...row, contract: 'ETH_USDT' }, 8, 'e', source.timeMapping?.(row))).toBeNull();
  expect(normalizeOfficialSettlement(ref, { ...row, t: s(cutoff) + 0.5 }, 8, 'e', source.timeMapping?.(row))).toBeNull();
});
