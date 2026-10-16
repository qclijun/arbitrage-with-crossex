import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { EngineTransport } from '../../src/core/engine-transport';
import { gateVenue } from '../../src/engine/venueGate';
import { mkWorld } from '../unit/engine-sim';
import { gate, fixture, HOST, makeTestApp, orderBody, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

it.each([false, true])('preserves write-ahead registration and incremental hedge quantities with pool=%s', async selected => {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-pool-ledger-'));
  const w = mkWorld({ storePath: path.join(dir, 'deals.sqlite') });
  const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const owner = new EngineTransport(() => clients);
  if (selected) owner.configure({ maxSockets: 4 });
  const venue = gateVenue(() => clients, fn => owner.use(fn));
  // Only price sources are controlled; all signed operations go through the actual SDK/adapter.
  w.deps.venue = { ...venue, refPrice: (contract, fresh) => w.venue.refPrice(contract, fresh),
    touch: (contract, side, tick) => w.venue.touch(contract, side, tick),
    bestQuote: (contract, side, tick) => w.venue.bestQuote(contract, side, tick) };
  const writes: Array<{ text: string; qty: string }> = [];
  const create = (id: string, executed: string, state: string) => {
    gate().post('/api/v4/crossex/orders').reply((_url, body) => {
      const order = body as { text: string; qty: string };
      const registered = w.store.listOrders(w.pairId).find(o => o.clientId === order.text);
      expect(registered).toMatchObject({ state: 'PENDING', qty: order.qty });
      expect(writes.some(o => o.text === order.text)).toBe(false);
      writes.push(order);
      return [200, { order_id: id }];
    });
    gate().get(`/api/v4/crossex/orders/${id}`).reply(200, orderBody({ order_id: id, state, executed_qty: executed }));
  };
  try {
    create('maker', '0', 'NEW');
    await w.step();
    expect(writes).toHaveLength(1);
    gate().get('/api/v4/crossex/orders/maker').reply(200,
      orderBody({ order_id: 'maker', state: 'PARTIALLY_FILLED', executed_qty: '0.05' }));
    create('hedge', '0.05', 'FILLED');
    await w.step();
    expect(writes).toHaveLength(2);
    expect(writes[1].qty).toBe('0.05');
    const orders = w.store.listOrders(w.pairId);
    expect(orders.find(o => o.leg === 'B')).toMatchObject({ qty: '0.05', cumQty: '0.05', state: 'CLOSED' });
    gate().get('/api/v4/crossex/orders/maker').reply(200,
      orderBody({ order_id: 'maker', state: 'PARTIALLY_FILLED', executed_qty: '0.05' }));
    await w.step();
    expect(writes).toHaveLength(2); // repeated cumulative fill does not obtain another hedge
  } finally { await owner.close(); w.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('does not allocate candidate pools on auth failure or busy recheck and retires only on successful commit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-pool-credentials-'));
  const w = mkWorld({ mode: 'DONE', storePath: path.join(dir, 'deals.sqlite') });
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, '');
  const oldEnv = { key: process.env.GATE_API_KEY, secret: process.env.GATE_API_SECRET };
  let current = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const original = current;
  const owner = new EngineTransport(() => current);
  owner.configure({ maxSockets: 4 });
  const oldSession = await owner.use(async c => c);
  const app = makeTestApp({ getClients: () => current, engine: { store: w.store, venue: w.deps.venue, clock: w.clock },
    credentials: { envPath, setClients: c => { owner.invalidate(); current = c; } } });
  const put = () => app.inject({ method: 'PUT', url: '/api/credentials', headers: HOST,
    payload: { key: 'replacement', secret: 'replacement-secret' } });
  try {
    gate().get('/api/v4/crossex/accounts').query(true).reply(401, { label: 'INVALID_KEY' });
    expect((await put()).statusCode).toBe(401);
    expect(await owner.use(async c => c)).toBe(oldSession);
    expect(current).toBe(original);
    gate().get('/api/v4/crossex/accounts').query(true).reply(() => {
      w.store.updatePair(w.pairId, { mode: 'OPENING' });
      return [200, fixture('account.json')];
    });
    expect((await put()).statusCode).toBe(409);
    expect(await owner.use(async c => c)).toBe(oldSession);
    expect(current).toBe(original);
    w.store.updatePair(w.pairId, { mode: 'DONE' });
    gate().get('/api/v4/crossex/accounts').query(true).reply(200, fixture('account.json'));
    expect((await put()).statusCode).toBe(200);
    expect(current).not.toBe(original);
    expect(owner.stats().maxSockets).toBeNull(); // no dedicated allocation during validation/commit
    const next = gate().get('/api/v4/crossex/orders/next').matchHeader('KEY', 'replacement')
      .reply(200, orderBody({ order_id: 'next' }));
    expect((await owner.use(c => c.getCrossexOrder('next'))).body.orderId).toBe('next');
    expect(next.isDone()).toBe(true);
  } finally {
    await app.close(); await owner.close(); w.store.close(); rmSync(dir, { recursive: true, force: true });
    if (oldEnv.key === undefined) delete process.env.GATE_API_KEY; else process.env.GATE_API_KEY = oldEnv.key;
    if (oldEnv.secret === undefined) delete process.env.GATE_API_SECRET; else process.env.GATE_API_SECRET = oldEnv.secret;
  }
});

it('leaves an ambiguous write PENDING then probes its original client id without a second create', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-pool-unknown-'));
  const w = mkWorld({ storePath: path.join(dir, 'deals.sqlite') });
  const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const owner = new EngineTransport(() => clients);
  owner.configure({ maxSockets: 4 });
  const venue = gateVenue(() => clients, fn => owner.use(fn));
  w.deps.venue = { ...venue, refPrice: (contract, fresh) => w.venue.refPrice(contract, fresh),
    touch: (contract, side, tick) => w.venue.touch(contract, side, tick),
    bestQuote: (contract, side, tick) => w.venue.bestQuote(contract, side, tick) };
  let text = '';
  const create = gate().post('/api/v4/crossex/orders').reply((_url, body) => {
    text = (body as { text: string }).text;
    expect(w.store.listOrders(w.pairId)[0]).toMatchObject({ clientId: text, state: 'PENDING' });
    return [503, { label: 'POST_ONLY_REJECT' }];
  });
  try {
    await w.step();
    expect(w.store.listOrders(w.pairId)).toHaveLength(1);
    expect(w.store.listOrders(w.pairId)[0].state).toBe('PENDING');
    const probe = gate().get(`/api/v4/crossex/orders/${text}`).reply(200,
      orderBody({ order_id: 'accepted', state: 'NEW', executed_qty: '0' }));
    await w.step();
    expect(probe.isDone() && create.isDone()).toBe(true);
    expect(w.store.listOrders(w.pairId)).toHaveLength(1);
    expect(w.store.listOrders(w.pairId)[0]).toMatchObject({ clientId: text, state: 'OPEN', venueOrderId: 'accepted' });
  } finally { await owner.close(); w.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
