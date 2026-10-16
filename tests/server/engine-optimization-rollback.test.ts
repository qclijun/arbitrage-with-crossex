import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { EngineTransport } from '../../src/core/engine-transport';
import { gateVenue } from '../../src/engine/venueGate';
import { mkWorld } from '../unit/engine-sim';
import { gate, orderBody, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it.each([
  { pool: false, wait: false }, { pool: true, wait: false },
  { pool: false, wait: true }, { pool: true, wait: true },
])('preserves confirmed hedge quantities with pool=$pool and wait=$wait', async ({ pool, wait }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-optimization-matrix-'));
  const w = mkWorld({ pricePolicy: 'best', b: { minNotional: '5' }, storePath: path.join(dir, 'ledger.sqlite') });
  const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const owner = new EngineTransport(() => clients);
  if (pool) owner.configure({ maxSockets: 1 });
  const venue = gateVenue(() => clients, fn => owner.use(fn));
  w.deps.skipUnrelatedMakerWait = wait;
  w.deps.venue = { ...venue, refPrice: (c, fresh) => w.venue.refPrice(c, fresh),
    bestQuote: (c, side, tick) => w.venue.bestQuote(c, side, tick) };
  const writes: string[] = [];
  const create = (id: string, filled: string, state: string) => {
    gate().post('/api/v4/crossex/orders').reply((_url, body) => {
      const order = body as { text: string; qty: string };
      expect(w.store.listOrders(w.pairId).find(o => o.clientId === order.text))
        .toMatchObject({ state: 'PENDING', qty: order.qty });
      writes.push(order.qty);
      return [200, { order_id: id }];
    });
    gate().get(`/api/v4/crossex/orders/${id}`).reply(200,
      orderBody({ order_id: id, executed_qty: filled, state }));
  };
  try {
    create('maker', '0', 'NEW');
    await w.step();
    gate().get('/api/v4/crossex/orders/maker').times(wait ? 2 : 1).reply(200,
      orderBody({ order_id: 'maker', executed_qty: '0.05', state: 'PARTIALLY_FILLED' }));
    create('hedge', '0.05', 'FILLED');
    await w.step();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe('0.05');
    gate().get('/api/v4/crossex/orders/maker').reply(200,
      orderBody({ order_id: 'maker', executed_qty: '0.05', state: 'PARTIALLY_FILLED' }));
    await w.step();
    expect(writes).toHaveLength(2);
    expect(w.store.listOrders(w.pairId).find(o => o.leg === 'B'))
      .toMatchObject({ qty: '0.05', cumQty: '0.05', state: 'CLOSED' });
  } finally { await owner.close(); w.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each((['pool', 'wait', 'combined'] as const).flatMap(disable =>
  [false, true].map(accepted => ({ disable, accepted }))))(
  'retires $disable during an in-flight B write (accepted=$accepted) without resending', async ({ disable, accepted }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'engine-optimization-rollback-'));
    const w = mkWorld({ pricePolicy: 'best', b: { minNotional: '5' }, storePath: path.join(dir, 'ledger.sqlite') });
    const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
    const owner = new EngineTransport(() => clients);
    owner.configure({ maxSockets: 1 });
    const venue = gateVenue(() => clients, fn => owner.use(fn));
    w.deps.skipUnrelatedMakerWait = true;
    w.deps.venue = { ...venue, refPrice: (c, fresh) => w.venue.refPrice(c, fresh),
      bestQuote: (c, side, tick) => w.venue.bestQuote(c, side, tick) };
    const entered = deferred<void>(), release = deferred<void>();
    let tick: Promise<void> | undefined;
    let bText = '';
    try {
      gate().post('/api/v4/crossex/orders').reply(200, { order_id: 'maker' });
      gate().get('/api/v4/crossex/orders/maker').reply(200,
        orderBody({ order_id: 'maker', executed_qty: '0', state: 'NEW' }));
      await w.step();
      gate().get('/api/v4/crossex/orders/maker').twice().reply(200,
        orderBody({ order_id: 'maker', executed_qty: '0.05', state: 'PARTIALLY_FILLED' }));
      gate().post('/api/v4/crossex/orders').reply(async (_url, body) => {
        bText = (body as { text: string }).text;
        expect(w.store.listOrders(w.pairId).find(o => o.clientId === bText)).toMatchObject({ state: 'PENDING', qty: '0.05' });
        entered.resolve();
        await release.promise;
        return accepted ? [200, { order_id: 'accepted' }] : [503, { label: 'POST_ONLY_REJECT' }]; // 5xx stays UNKNOWN.
      });
      const confirmation = accepted ? gate().get('/api/v4/crossex/orders/accepted').matchHeader('KEY', TEST_KEY)
        .reply(200, orderBody({ order_id: 'accepted', executed_qty: '0.05', state: 'FILLED' })) : null;
      tick = w.step();
      await entered.promise;
      if (disable !== 'wait') owner.configure(null);
      if (disable !== 'pool') w.deps.skipUnrelatedMakerWait = false;
      expect(owner.stats()).toMatchObject({ inFlight: 1, retiringSessions: disable === 'wait' ? 0 : 1 });
      expect(w.store.getPair(w.pairId)?.mode).toBe('OPENING');
      release.resolve();
      await tick;
      expect(owner.stats().inFlight).toBe(0);
      expect(w.store.listOrders(w.pairId).find(o => o.leg === 'B')).toMatchObject({ clientId: bText, state: accepted ? 'CLOSED' : 'PENDING' });
      if (confirmation) expect(confirmation.isDone()).toBe(true);
      const probe = accepted ? null : gate().get(`/api/v4/crossex/orders/${bText}`).matchHeader('KEY', TEST_KEY)
        .reply(200, orderBody({ order_id: 'accepted', executed_qty: '0.05', state: 'FILLED' }));
      gate().get('/api/v4/crossex/orders/maker').reply(200,
        orderBody({ order_id: 'maker', executed_qty: '0.05', state: 'PARTIALLY_FILLED' }));
      await w.step();
      if (probe) expect(probe.isDone()).toBe(true);
      expect(w.store.listOrders(w.pairId)).toHaveLength(2);
      expect(w.store.listOrders(w.pairId).find(o => o.leg === 'B'))
        .toMatchObject({ clientId: bText, qty: '0.05', cumQty: '0.05', state: 'CLOSED' });
      expect(await owner.use(async c => c === clients.crossEx)).toBe(disable !== 'wait');
    } finally {
      release.resolve(); await tick;
      await owner.close(); w.store.close(); rmSync(dir, { recursive: true, force: true });
    }
  },
);
