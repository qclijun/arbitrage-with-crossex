import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADDRESS, HL, market } from '../helpers/boros-pair-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp } from './helpers/gate-nock';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });
const acc = (tail = '000002ffffff') => ADDRESS + tail;
const row = (tail = '000002ffffff') => ({ marketAcc: acc(tail), netBalance: '100000000000000000',
  initialMargin: '80000000000000000', availableInitialMargin: '12000000000000000',
  availableMaintMargin: '60000000000000000', positions: [{ marketId: HL, signedSize: '-3000000000000000000' }] });
async function read(rows: unknown[] = [row()], extra = {}, activeRows: unknown[] = [], recovered = { results: [] as unknown[] }) {
  app = makeTestApp({ borosFetch: borosStub({
    '/apis/v1/markets': { results: [market(HL, 'Hyperliquid', .08)] },
    '/apis/v1/accounts/market-acc-infos-by-root': { results: rows, ...extra },
    '/apis/v1/accounts/active-positions': { results: activeRows },
    '/apis/v1/accounts/market-acc-infos': recovered,
  }) });
  return app.inject({ method: 'GET', url: `/api/boros/collateral?address=${ADDRESS}&fresh=1`, headers: HOST });
}
describe('read-only Boros collateral', () => {
  it('uses official available margin and separates cross/isolated', async () => {
    const res = await read([row(), { ...row('000002000080'), netBalance: '200000000000000000' }]);
    expect(res.statusCode).toBe(200);
    const eth = res.json().data.tokens[0];
    expect(eth.cross).toMatchObject({ netBalance: .1, initialMargin: .08,
      netBalanceExact: '0.1', availableInitialMargin: .012, activePositions: 1, imCoverage: 1.25 });
    expect(eth.cross.maintenanceMargin).toBeCloseTo(.04);
    expect(eth.cross.mmCoverage).toBeCloseTo(2.5);
    expect(eth.isolated[0].netBalance).toBe(.2);
    expect(res.json().data.tokens[1].cross).toBeNull();
  });
  it('preserves all 18 raw collateral decimals in the account response', async () => {
    const res = await read([{ ...row(), netBalance: '123456789012345678' }]);
    const cross = res.json().data.tokens[0].cross;
    expect(cross.netBalance).toBe(.12345678901234568);
    expect(cross.netBalanceExact).toBe('0.123456789012345678');
  });
  it('keeps missing fields UNKNOWN instead of fabricating zero', async () => {
    const res = await read([{ marketAcc: acc() }]);
    expect(res.json().data.tokens[0].cross).toMatchObject({ netBalance: null,
      netBalanceExact: null,
      availableInitialMargin: null, initialMargin: null, maintenanceMargin: null,
      activePositions: null, imCoverage: null, mmCoverage: null });
  });
  it('filters the configured subaccount', async () => {
    vi.stubEnv('BOROS_ACCOUNT_ID', '1');
    const res = await read([row(), row('010002ffffff')]);
    expect(res.json().data.accountId).toBe(1);
    expect(res.json().data.tokens[0].cross.marketAcc).toBe(acc('010002ffffff'));
  });
  it('rejects incomplete pagination rather than reporting absent balances', async () => {
    expect((await read([], { resumeToken: 'next' })).statusCode).toBe(502);
  });
  it('rejects malformed account responses', async () => {
    expect((await read([{ marketAcc: 'broken' }])).statusCode).toBe(502);
  });
  it.each([
    ['missing accounts', { results: [] }],
    ['partial accounts', { results: [row()] }],
    ['duplicate accounts', { results: [row(), row()] }],
    ['unexpected accounts', { results: [row(), row('000002000081')] }],
    ['incomplete pagination', { results: [row(), row('000002000080')], resumeToken: 'next' }],
  ])('rejects %s in the active-account recovery read', async (_label, recovered) => {
    const activeRows = [row(), row('000002000080')].map((r) => ({
      marketAcc: r.marketAcc, marketId: HL, signedSize: '-3000000000000000000',
    }));
    expect((await read([], {}, activeRows, recovered)).statusCode).toBe(502);
  });
  it('accepts complete recovered accounts regardless of order or address case', async () => {
    const activeRows = [row(), row('000002000080')].map((r) => ({
      marketAcc: r.marketAcc, marketId: HL, signedSize: '-3000000000000000000',
    }));
    const res = await read([], {}, activeRows, { results: [
      row('000002000080'), { ...row(), marketAcc: acc().toUpperCase() },
    ] });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.tokens[0].cross.netBalance).toBe(.1);
    expect(res.json().data.tokens[0].isolated).toHaveLength(1);
  });
  it('reports confirmed absent pools only after a successful read', async () => {
    const res = await read([]);
    expect(res.json().data.tokens.map((t: { cross: unknown }) => t.cross)).toEqual([null, null, null]);
  });
});
