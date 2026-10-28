/**
 * Slice-scoped reductions on POST /api/deals, GET /api/slices and explicit
 * recovery (ticket 15). A reduction may take only what its slice holds and
 * what the account can still reduce once unfinished reductions keep their
 * share — checked on fresh reads before anything is touched.
 */
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from '../unit/engine-sim';
import { deal, order } from '../helpers/slice-fixture';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  nock.cleanAll();
});

function rules(): unknown[] {
  const row = (symbol: string) => ({
    symbol, state: 'live', business_type: 'FUTURE', lot_size: '0.001', min_size: '0', min_notional: '0',
    tick_size: '0.01', max_market_size: '10000', max_limit_size: '10000',
  });
  return [row(A_CONTRACT), row(B_CONTRACT)];
}

/** A store with slice X holding long 1 on A and short 1 on B. */
function world(): Store {
  const store = new Store(':memory:');
  store.slices.create({
    id: 'X', kind: 'funding-two-leg', source: {}, now: 1, observed: { [A_CONTRACT]: '0', [B_CONTRACT]: '0' },
    legs: [{ leg: 'long', contract: A_CONTRACT, side: 'long' }, { leg: 'short', contract: B_CONTRACT, side: 'short' }],
  });
  deal(store, 'open-x', { contract: A_CONTRACT, side: 'BUY' }, { contract: B_CONTRACT, side: 'SELL' }, '1');
  store.slices.attach('open-x', 'X', 'open');
  order(store, 'open-x', 'A', '1', '1');
  order(store, 'open-x', 'B', '1', '1');
  store.slices.bookFills('open-x', 2);
  store.updatePair('open-x', { mode: 'DONE' });
  app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock: new VirtualClock() } });
  return store;
}

const POSITIONS = [{ symbol: A_CONTRACT, position_qty: '1' }, { symbol: B_CONTRACT, position_qty: '-1' }];

function mockReads(times = 3): void {
  mockGateGet('/rule/symbols', { body: rules(), times });
  mockGateGet('/positions', { body: POSITIONS, times: times * 2 });
  mockGateGet('/accounts', { fixture: 'account.json', times });
}

const cut = (id: string, qty: string, over?: Record<string, unknown>) => ({
  id, purpose: 'reduce', slice: { id: 'X' }, qty, execution: 'taker', clipBandPct: 0.5,
  a: { symbol: A_CONTRACT, side: 'SELL', reduceOnly: true },
  b: { symbol: B_CONTRACT, side: 'BUY', reduceOnly: true },
  ...over,
});
const post = (body: object) => app.inject({ method: 'POST', url: '/api/deals', headers: HOST, payload: body });

describe('slice-scoped reductions', () => {
  it('accepts a reduction within the slice and reserves it against the slice', async () => {
    const store = world();
    mockReads();
    const res = await post(cut('cut-0001', '0.5'));
    expect(res.statusCode, res.body).toBe(202);
    expect(store.getPair('cut-0001')).toMatchObject({ purpose: 'reduce' });
    expect(store.slices.reducible('X')).toMatchObject({ long: { reserved: '0.5', reducible: '0.5' }, short: { reserved: '0.5' } });
  });

  it('refuses more than the slice holds, even where the account holds more, creating nothing', async () => {
    const store = world();
    mockGateGet('/rule/symbols', { body: rules() });
    mockGateGet('/positions', { body: [{ symbol: A_CONTRACT, position_qty: '2' }], times: 4 }); // 1 is not X's
    mockGateGet('/accounts', { fixture: 'account.json' });
    const res = await post(cut('cut-0001', '1.5', { b: null }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.label).toBe('slice-insufficient');
    expect(store.getPair('cut-0001')).toBeNull();
  });

  it('refuses a second reduction for the share an unfinished one already reserved', async () => {
    const store = world();
    mockReads(4);
    expect((await post(cut('cut-0001', '0.7'))).statusCode).toBe(202);
    const second = await post(cut('cut-0002', '0.5'));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ label: 'slice-insufficient' });
    expect(store.getPair('cut-0002')).toBeNull();
  });

  it('refuses when other unfinished reductions already take the account position', async () => {
    const store = world();
    deal(store, 'close-other', { contract: A_CONTRACT, side: 'SELL', reduceOnly: true }, null, '0.8');
    mockReads();
    const res = await post(cut('cut-0001', '0.5', { b: null }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ label: 'position-insufficient' });
    expect(store.getPair('cut-0001')).toBeNull();
  });

  it('names a slice only for a reduction, and only a slice that exists', async () => {
    const store = world();
    mockReads();
    const open = await post({
      id: 'open-more', purpose: 'boros-strategy', boros: { base: 'ETH', venues: ['OKX'] }, slice: { id: 'X' },
      a: { symbol: A_CONTRACT, side: 'BUY' }, qty: '0.1', execution: 'taker',
    });
    expect(open.statusCode).toBe(400);
    expect(open.json().error.label).toBe('slice-purpose');
    const unknown = await post(cut('cut-0001', '0.1', { slice: { id: 'nope' } }));
    expect(unknown.statusCode).toBe(400);
    expect(store.listPairs().map((p) => p.id)).toEqual(['open-x']);
  });
});

describe('GET /api/slices', () => {
  it('lists slices with their room and reconciles each tracked contract on a fresh read', async () => {
    world();
    mockGateGet('/positions', { body: POSITIONS });
    const data = (await app.inject({ method: 'GET', url: '/api/slices', headers: HOST })).json().data;
    expect(data.slices).toEqual([expect.objectContaining({ id: 'X', legs: expect.any(Array), reducible: expect.any(Object) })]);
    expect(data.contracts).toEqual([
      expect.objectContaining({ contract: A_CONTRACT, status: 'reconciled', attributed: '1', unattributed: '0' }),
      expect.objectContaining({ contract: B_CONTRACT, status: 'reconciled', attributed: '-1' }),
    ]);
  });

  it('reports UNKNOWN, never zero, when positions cannot be read', async () => {
    world();
    mockGateGet('/positions', { status: 500, body: {} });
    const data = (await app.inject({ method: 'GET', url: '/api/slices', headers: HOST })).json().data;
    expect(data.contracts.map((c: { status: string; actual: unknown }) => [c.status, c.actual])).toEqual([['unknown', null], ['unknown', null]]);
  });
});

describe('POST /api/slices/recover', () => {
  const recover = (body: object) => app.inject({ method: 'POST', url: '/api/slices/recover', headers: HOST, payload: body });

  it('accepts only the position the server reads now', async () => {
    const store = world();
    mockGateGet('/positions', { body: [{ symbol: A_CONTRACT, position_qty: '0.6' }] });
    const res = await recover({ contract: A_CONTRACT, observedActual: '0.5', evidence: 'x', adjustments: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.label).toBe('position-changed');
    expect(store.slices.book(A_CONTRACT)!.explained).toBe('1');
  });

  it('re-baselines with the stated adjustment and reconciles', async () => {
    const store = world();
    mockGateGet('/positions', { body: [{ symbol: A_CONTRACT, position_qty: '0.6' }] });
    const res = await recover({
      contract: A_CONTRACT, observedActual: '0.6', evidence: 'closed 0.4 by hand',
      adjustments: [{ sliceId: 'X', leg: 'long', delta: '-0.4' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'reconciled', attributed: '0.6', unattributed: '0' });
    expect(store.slices.movements(null).map((m) => [m.kind, m.delta])).toEqual([['external', '-0.4']]);
  });

  it('refuses an adjustment that does not fit, changing nothing', async () => {
    const store = world();
    mockGateGet('/positions', { body: [{ symbol: A_CONTRACT, position_qty: '0.6' }] });
    const res = await recover({ contract: A_CONTRACT, observedActual: '0.6', evidence: 'x', adjustments: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.label).toBe('slice-invalid-adjustment');
    expect(store.slices.book(A_CONTRACT)!.explained).toBe('1');
  });
});
