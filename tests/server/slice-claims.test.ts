import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/engine/db';
import { processSliceClaims } from '../../src/engine/slice-claims';
import type { ClaimEvidence, ClaimInput } from '../../src/engine/claim-types';
import { claimReader } from '../../src/server/claim-reads';
import { makeClients } from '../../src/core/clients';
import { FakeVenue } from '../unit/engine-sim';
import { LONG_C, SHORT_C } from '../helpers/slice-fixture';
import { HOST, makeTestApp, mockGateGet, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

let app: FastifyInstance;
let store: Store;
afterEach(async () => { await app?.close(); store?.close(); app = undefined!; store = undefined!; nock.cleanAll(); });
const input: ClaimInput = { kind: 'funding-two-leg', legs: [
  { contract: LONG_C, side: 'long', qty: '0.5' }, { contract: SHORT_C, side: 'short', qty: '0.5' },
], boros: [] };
let current: ClaimEvidence;
let now: number;
function world() {
  store = new Store(':memory:'); now = 100;
  current = { readAt: now, positions: { [LONG_C]: '1', [SHORT_C]: '-1' }, contracts: [LONG_C, SHORT_C], openOrders: [], boros: null };
  const venue = new FakeVenue();
  vi.spyOn(venue, 'create'); vi.spyOn(venue, 'cancel'); vi.spyOn(venue, 'setLeverage');
  const wake = vi.fn();
  const read = vi.fn(async () => structuredClone(current));
  app = makeTestApp({ engine: { store, venue, clock: { now: () => now }, wake }, readClaimEvidence: read });
  return { read, venue, wake };
}
const post = (url: string, payload?: object) => app.inject({ method: 'POST', url: `/api${url}`, headers: HOST, payload });
async function preview(): Promise<string> {
  const r = await post('/slices/claims/preview', input);
  expect(r.statusCode).toBe(200);
  return r.json().data.id;
}

describe('ownership preview / confirm / normal engine', () => {
  it('lists an unconfirmed identity for reload and proves late confirmation impossible only after server expiry', async () => {
    world(); const id = await preview();
    expect((await app.inject({ url: '/api/slices/claims', headers: HOST })).json().data[0]).toMatchObject({ id, confirmationPossible: true });
    now += 10_000;
    expect((await app.inject({ url: `/api/slices/claims/${id}`, headers: HOST })).json().data.confirmationPossible).toBe(false);
    expect((await post(`/slices/claims/${id}/confirm`)).statusCode).toBe(409);
    expect(store.slices.list()).toEqual([]);
  });
  it('lets an explicit discard fence a confirmation still reading evidence, without undoing accepted claims', async () => {
    const { read } = world(); const id = await preview();
    let resolve!: (e: ClaimEvidence) => void;
    let started!: () => void;
    const reading = new Promise<void>((r) => { started = r; });
    read.mockImplementationOnce(() => { started(); return new Promise((r) => { resolve = r; }); });
    const confirmation = post(`/slices/claims/${id}/confirm`);
    await reading;
    expect((await post(`/slices/claims/${id}/discard`)).json().data.status).toBe('rejected');
    resolve(current); await confirmation;
    expect((await post(`/slices/claims/${id}/confirm`)).json().data.status).toBe('rejected');
    await processSliceClaims(store, read, () => now);
    expect(store.slices.list()).toEqual([]);
  });
  it('is read-only until engine application; duplicate confirms and lost response retries reuse one command', async () => {
    const { read, venue, wake } = world();
    const id = await preview();
    const responses = await Promise.all([post(`/slices/claims/${id}/confirm`), post(`/slices/claims/${id}/confirm`)]);
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(wake).toHaveBeenCalled();
    expect(store.slices.list()).toEqual([]);
    await processSliceClaims(store, read, () => now);
    expect((await post(`/slices/claims/${id}/confirm`)).json().data.status).toBe('applied');
    const list = await app.inject({ url: '/api/slices/claims', headers: HOST });
    expect(list.json().data).toHaveLength(1);
    expect(store.slices.list()).toHaveLength(1);
    expect(store.listPairs()).toEqual([]);
    expect(venue.create).not.toHaveBeenCalled(); expect(venue.cancel).not.toHaveBeenCalled(); expect(venue.setLeverage).not.toHaveBeenCalled();
    expect(store.admission.read().open).toBe(false);
    const bypass = await post('/deals', { id: 'bypass', purpose: 'funding-two-leg', slice: { id: `claim:${id}` }, qty: '1',
      execution: 'taker', a: { symbol: LONG_C, side: 'BUY' }, b: { symbol: SHORT_C, side: 'SELL' } });
    expect(bypass.statusCode).toBe(409);
    expect(bypass.json().error.label).toBe('funding-admission-required');
  });

  it.each(['position', 'order', 'expired', 'missing'] as const)('revalidates %s on confirmation', async (mode) => {
    world(); const id = await preview();
    if (mode === 'position') current.positions[LONG_C] = '2';
    if (mode === 'order') current.openOrders = [SHORT_C];
    if (mode === 'expired') now += 10_000;
    if (mode === 'missing') delete current.positions[LONG_C];
    const r = await post(`/slices/claims/${id}/confirm`);
    expect(r.statusCode).toBe(409);
    expect(store.claims.get(id)?.status).toBe('preview');
    expect(store.slices.list()).toEqual([]);
  });

  it('rejects competing claims in the engine and exposes remaining unattributed quantities and UNKNOWN amounts', async () => {
    const { read } = world(); const one = await preview(); const two = await preview();
    await post(`/slices/claims/${one}/confirm`); await post(`/slices/claims/${two}/confirm`);
    await processSliceClaims(store, read, () => now);
    await processSliceClaims(store, read, () => now);
    expect(store.claims.list().map((r) => r.status).sort()).toEqual(['applied', 'rejected']);
    mockGateGet('/positions', { body: [{ symbol: LONG_C, position_qty: '1' }, { symbol: SHORT_C, position_qty: '-1' }] });
    const r = await app.inject({ url: '/api/slices', headers: HOST });
    expect(r.json().data.contracts[0]).toMatchObject({ unattributed: '0.5', status: 'reconciled' });
    expect(r.json().data.slices[0].attribution).toMatchObject({ funding: null, fees: null, pnl: null, equityReturn: null });
  });

  it('keeps mandatory API authentication on the new read and write routes', async () => {
    world();
    const r = await app.inject({ method: 'POST', url: '/api/slices/claims/preview', headers: { host: 'localhost:6688' }, payload: input });
    expect(r.statusCode).toBe(401);
  });
});

describe('production ownership evidence adapter', () => {
  function reads(body: unknown) {
    mockGateGet('/positions', { body }); mockGateGet('/open_orders', { body: [] });
    mockGateGet('/rule/symbols', { body: [LONG_C, SHORT_C].map((symbol) => ({ symbol, state: 'live', business_type: 'FUTURE' })) });
    return claimReader(() => makeClients({ key: TEST_KEY, secret: TEST_SECRET }), () => 100)({});
  }
  it('reads fresh exact live contracts and signed positions with no wire mutations', async () => {
    const e = await reads([{ symbol: LONG_C, position_qty: '1', position_side: 'LONG' }, { symbol: SHORT_C, position_qty: '1', position_side: 'SHORT' }]);
    expect(e.positions).toEqual({ [LONG_C]: '1', [SHORT_C]: '-1' });
    expect(e.contracts).toEqual([LONG_C, SHORT_C]);
  });
  it.each([
    { body: [{ symbol: LONG_C }] },
    { body: [{ symbol: LONG_C, position_qty: '1', position_side: 'future-state' }] },
    { body: [{ symbol: LONG_C, position_qty: '1', position_side: 'LONG' }, { symbol: LONG_C, position_qty: '1', position_side: 'SHORT' }] },
  ])('refuses incomplete or internally opposed position evidence %#', async ({ body }) => {
    await expect(reads(body)).rejects.toThrow();
  });
});
