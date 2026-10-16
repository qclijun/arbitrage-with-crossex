import { afterEach, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { EngineTransport } from '../../src/core/engine-transport';
import { gateVenue } from '../../src/engine/venueGate';
import { gate, orderBody, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

const owners: EngineTransport[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(o => o.close())); });

it('keeps the SDK signing, decimal headers and accepted-create confirmation contract', async () => {
  const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const owner = new EngineTransport(() => clients);
  owners.push(owner);
  owner.configure({ maxSockets: 4 });
  const venue = gateVenue(() => clients, fn => owner.use(fn));
  let body: unknown;
  const write = gate().post('/api/v4/crossex/orders').matchHeader('KEY', TEST_KEY)
    .matchHeader('SIGN', v => typeof v === 'string' && /^[a-f0-9]{128}$/.test(v))
    .matchHeader('Timestamp', v => /^\d+(\.\d+)?$/.test(String(v)))
    .matchHeader('X-Gate-Size-Decimal', '1').matchHeader('X-Gate-Channel-Id', 'boros')
    .reply((_url, sent) => { body = sent; return [200, { order_id: '9007199254740993' }]; });
  const confirm = gate().get('/api/v4/crossex/orders/9007199254740993').reply(503, { label: 'SERVER_ERROR' });
  const out = await venue.create({ contract: 'OKX_ETH_USDT', side: 'BUY', qty: '0.123456789123',
    price: '2500.01', tif: 'poc', clientText: 'tExampleA1', reduceOnly: false });
  expect(out, JSON.stringify(out)).toMatchObject({ kind: 'ok', snapshot: { venueOrderId: '9007199254740993', rawStatus: 'NEW' } });
  expect(body).toMatchObject({ qty: '0.123456789123', price: '2500.01', time_in_force: 'POC', text: 'tExampleA1' });
  expect(write.isDone() && confirm.isDone()).toBe(true);
  expect(owner.stats()).toMatchObject({ maxSockets: 4, inFlight: 0 });
});

it.each([
  { message: 'reset', code: 'ECONNRESET' },
  { message: 'timeout', code: 'ETIMEDOUT' },
])('does not resend a write after $code', async error => {
  const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const createClient = clients.engineClient!;
  let calls = 0;
  clients.engineClient = http => {
    http.defaults.adapter = async () => { calls++; throw Object.assign(new Error(error.message), error); };
    return createClient(http);
  };
  const owner = new EngineTransport(() => clients);
  owners.push(owner);
  owner.configure({ maxSockets: 4 });
  const venue = gateVenue(() => clients, fn => owner.use(fn));
  expect(await venue.create({ contract: 'OKX_ETH_USDT', side: 'BUY', qty: '1',
    tif: 'ioc', clientText: 'tUnknownA1', reduceOnly: false })).toMatchObject({ kind: 'unknown' });
  expect(calls).toBe(1);
  expect(await venue.cancel({ clientText: 'tUnknownA1', venueOrderId: 'id' }))
    .toMatchObject({ kind: 'unknown' });
  expect(calls).toBe(2);
});

it('keeps 5xx ambiguous and refuses signed redirects without leaking headers', async () => {
  const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const owner = new EngineTransport(() => clients);
  owners.push(owner);
  owner.configure({ maxSockets: 4 });
  const venue = gateVenue(() => clients, fn => owner.use(fn));
  const write = gate().post('/api/v4/crossex/orders').reply(503, { label: 'POST_ONLY_REJECT' });
  expect(await venue.create({ contract: 'OKX_ETH_USDT', side: 'BUY', qty: '1',
    tif: 'poc', clientText: 'tUnknownA1', reduceOnly: false })).toMatchObject({ kind: 'unknown' });
  const redirect = gate().get('/api/v4/crossex/orders/id').reply(302, {}, { Location: 'https://example.invalid/steal' });
  expect(await venue.getOrder({ clientText: 'tUnknownA1', venueOrderId: 'id' }))
    .toMatchObject({ kind: 'error' });
  expect(write.isDone() && redirect.isDone()).toBe(true);
});

it('pins an in-flight create/confirm chain while a retired session drains', async () => {
  let current = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const old = current;
  const owner = new EngineTransport(() => current);
  owners.push(owner);
  owner.configure({ maxSockets: 4 });
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { unblock = resolve; });
  const pending = owner.use(async client => {
    await client.getCrossexOrder('old-before');
    entered();
    await wait;
    return (await client.getCrossexOrder('old-after')).body.orderId;
  });
  const before = gate().get('/api/v4/crossex/orders/old-before').matchHeader('KEY', TEST_KEY)
    .reply(200, orderBody({ order_id: 'old-before' }));
  await started;
  expect(owner.stats().inFlight).toBe(1);
  owner.invalidate();
  expect(owner.stats()).toMatchObject({ maxSockets: null, inFlight: 1, retiringSessions: 1, socketLimitAcrossSessions: 4 });
  current = makeClients({ key: 'replacement', secret: 'replacement-secret' });
  const after = gate().get('/api/v4/crossex/orders/old-after').matchHeader('KEY', TEST_KEY)
    .reply(200, orderBody({ order_id: 'old-after' }));
  const newer = gate().get('/api/v4/crossex/orders/new').matchHeader('KEY', 'replacement')
    .reply(200, orderBody({ order_id: 'new' }));
  expect((await owner.use(c => c.getCrossexOrder('new'))).body.orderId).toBe('new');
  let closed = false;
  const closing = owner.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  await expect(owner.use(c => c.getCrossexOrder('forbidden'))).rejects.toThrow('closed');
  unblock();
  expect(await pending).toBe('old-after');
  await closing;
  expect(before.isDone() && after.isDone() && newer.isDone()).toBe(true);
  expect(old.crossEx).not.toBe(current.crossEx);
});

it('selects the original client by default and independently disables a selected pool', async () => {
  const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const owner = new EngineTransport(() => clients);
  owners.push(owner);
  expect(await owner.use(async c => c === clients.crossEx)).toBe(true);
  expect(owner.stats().maxSockets).toBeNull();
  owner.configure({ maxSockets: 4 });
  expect(await owner.use(async c => c === clients.crossEx)).toBe(false);
  owner.configure(null);
  expect(await owner.use(async c => c === clients.crossEx)).toBe(true);
  for (const maxSockets of [0, 17, NaN, Infinity, 1.5]) {
    expect(() => owner.configure({ maxSockets })).toThrow('explicit socket limit');
  }
});

it('keeps failed client acquisition ambiguous without placing or falling back', async () => {
  const clients = makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const owner = new EngineTransport(() => clients, () => ({ protocol: 'ftp', host: 'invalid', port: 21 }));
  owners.push(owner);
  owner.configure({ maxSockets: 4 });
  const venue = gateVenue(() => clients, fn => owner.use(fn));
  expect(await venue.create({ contract: 'OKX_ETH_USDT', side: 'BUY', qty: '1',
    tif: 'ioc', clientText: 'tUnknownA1', reduceOnly: false })).toMatchObject({ kind: 'unknown' });
  expect(await venue.getOrder({ clientText: 'tUnknownA1' })).toMatchObject({ kind: 'error' });
  expect(await venue.sweepForOrder('OKX_ETH_USDT', 'tUnknownA1', 0)).toEqual({ covered: false });
  expect(owner.stats().maxSockets).toBeNull();
});
