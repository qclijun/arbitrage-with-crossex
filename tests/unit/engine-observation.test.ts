import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { gateVenue } from '../../src/engine/venueGate';
import type { Clients } from '../../src/core/clients';
import { fetchVenueBook } from '../../src/core/estimate/books';
import { EngineObservation, recordObservation, observeCall } from '../../src/engine/observation';
import { mkWorld, A_CONTRACT, assertInvariants } from './engine-sim';

const faults = vi.hoisted(() => ({ workerUnavailable: false }));
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (faults.workerUnavailable) throw new Error('worker resource exhausted');
      super(...args);
    }
  } };
});
vi.mock('../../src/core/estimate/books', () => ({ fetchVenueBook: vi.fn() }));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'engine-observation-'));
  dirs.push(dir);
  const observation = new EngineObservation(dir, () => {});
  const w = mkWorld({ storePath: path.join(dir, 'ledger.sqlite') });
  w.deps.observation = observation;
  return { dir, observation, w };
}
async function events(dir: string) {
  const files = (await readdir(path.join(dir, 'details'))).sort();
  return (await Promise.all(files.map(f => readFile(path.join(dir, 'details', f), 'utf8'))))
    .join('').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
}
it('correlates confirmed fills, committed reservations and local send/receipt without changing the ledger', async () => {
  const { dir, observation, w } = await setup();
  try {
    await w.step();
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    await w.step();
    assertInvariants(w);
    await observation.flush();
    const rows = await events(dir);
    const fill = rows.find(e => e.stage === 'fill-confirmed' && e.leg === 'A');
    const reservation = rows.find(e => e.stage === 'registered' && e.leg === 'B');
    const send = rows.find(e => e.stage === 'send-entry' && e.leg === 'B');
    const receipt = rows.find(e => e.stage === 'receipt' && e.leg === 'B');
    expect(fill.quantity).toBe('0.05');
    expect(reservation.quantity).toBe('0.05');
    expect(fill.tick).toBe(reservation.tick);
    expect(reservation.client).toBe(send.client);
    expect(send.client).toBe(receipt.client);
    expect(fill.monoMs).toBeLessThanOrEqual(reservation.monoMs);
    expect(reservation.monoMs).toBeLessThanOrEqual(send.monoMs);
    expect(send.monoMs).toBeLessThanOrEqual(receipt.monoMs);
    expect(receipt.outcome).toBe('ok');
    expect(fill.sourceTime).toBeNull();
    expect(fill.sourceTimeStatus).toBe('UNKNOWN');
    expect(JSON.stringify(rows)).not.toContain(w.pairId + '"');
    expect(JSON.stringify(rows)).not.toContain(w.store.listOrders(w.pairId)[0].clientId);
    expect(rows.some(e => e.stage === 'projection' && e.aFilled === '0.05' && e.bFilled === '0' && e.bReserved === '0')).toBe(true);
  } finally { w.store.close(); await observation.close(); }
});

it('drops excess evidence and reports UNKNOWN while trading keeps hedging', async () => {
  const { dir, observation, w } = await setup();
  await observation.close();
  const alerts: string[] = [];
  const tiny = new EngineObservation(dir, m => alerts.push(m), { bufferBytes: 1, detailBytes: 4096, detailAgeMs: 1000 });
  w.deps.observation = tiny;
  try {
    await w.step();
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    await w.step();
    assertInvariants(w);
    expect(w.store.listOrders(w.pairId).filter(o => o.leg === 'B')).toHaveLength(1);
    expect(tiny.stats().bufferedBytes).toBe(0);
    expect(tiny.stats().dropped).toBeGreaterThan(0);
    expect(tiny.stats().evidence).toBe('UNKNOWN');
    await tiny.flush();
    await new Promise(resolve => setImmediate(resolve));
    expect(alerts).toHaveLength(1);
  } finally { w.store.close(); await tiny.close(); }
});

it('persists a bounded number of segments and expires only owned evidence', async () => {
  const { dir, observation, w } = await setup();
  try {
    for (let i = 0; i < 8; i++) { await w.step(); await observation.flush(); }
    expect((await readdir(path.join(dir, 'details'))).length).toBe(1);
  } finally { w.store.close(); await observation.close(); }
});

it('separates the SDK create receipt from failed follow-up confirmation and exposes real cache residence', async () => {
  const { dir, observation, w } = await setup();
  const venue = gateVenue(() => ({ crossEx: {
    createCrossexOrder: async () => ({ body: { orderId: 'private-order' } }),
    getCrossexOrder: async () => { throw new Error('secret auth header'); },
  } }) as unknown as Clients);
  vi.mocked(fetchVenueBook).mockResolvedValue({ bids: [[100, 1]], asks: [[102, 1]], ts: Date.now() });
  try {
    await observation.tickPair('secret-account-deal', async scope => {
      const out = await venue.create({ contract: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', qty: '1', tif: 'poc', clientText: 'private-client' }, scope);
      expect(out.kind).toBe('ok');
      expect(await venue.refPrice('BINANCE_FUTURE_ETH_USDT', false, scope)).toBe('101');
      expect(await venue.refPrice('BINANCE_FUTURE_ETH_USDT', false, scope)).toBe('101');
    });
    await observation.flush();
    const rows = await events(dir);
    expect(rows.find(e => e.operation === 'sdk-create' && e.stage === 'receipt').outcome).toBe('ok');
    expect(rows.find(e => e.operation === 'sdk-confirm' && e.stage === 'receipt').outcome).toBe('unknown');
    const cache = rows.filter(e => e.stage === 'cache');
    expect(cache.map(e => e.cacheHit)).toEqual([false, true]);
    expect(cache[0].cacheKey).toBe(cache[1].cacheKey);
    expect(cache[1].cacheWrittenUtcMs).toBe(cache[0].cacheWrittenUtcMs);
    expect(cache[1].cacheResidenceMs).toBeGreaterThanOrEqual(0);
    expect(cache[1].sourceTimeStatus).toBe('UNKNOWN');
    for (const secret of ['private-order', 'private-client', 'secret auth header', 'secret-account-deal']) expect(JSON.stringify(rows)).not.toContain(secret);
  } finally { w.store.close(); await observation.close(); }
});

it('rotates by age and capacity, preserves foreign files and applies report retention', async () => {
  const { dir, observation, w } = await setup();
  await observation.close();
  const details = path.join(dir, 'details');
  const reports = path.join(dir, 'reports');
  await writeFile(path.join(details, 'keep-history.jsonl'), 'existing-history');
  await writeFile(path.join(details, 'obs-1-abcd-1.jsonl'), 'expired');
  await writeFile(path.join(reports, 'obs-1-abcd-1.jsonl'), 'expired-report');
  await writeFile(path.join(reports, `obs-${Date.now()}-abcd-2.jsonl`), Buffer.alloc(11 * 1024 * 1024));
  const bounded = new EngineObservation(dir, () => {}, { bufferBytes: 1024 * 1024, detailBytes: 6000, detailAgeMs: 7 * 86400000 });
  try {
    for (let i = 0; i < 6; i++) {
      await bounded.tickPair('deal', async scope => recordObservation(scope, 'decision', { action: 'idle' }));
      await bounded.flush();
    }
    const owned = (await readdir(details)).filter(f => f.startsWith('obs-'));
    const sizes = await Promise.all(owned.map(f => stat(path.join(details, f))));
    expect(sizes.reduce((n, s) => n + s.size, 0)).toBeLessThanOrEqual(6000);
    expect(await readFile(path.join(details, 'keep-history.jsonl'), 'utf8')).toBe('existing-history');
    expect(await readdir(reports)).toEqual([]);
    expect(bounded.stats().rotations).toBeGreaterThanOrEqual(4);
    expect(w.store.getPair(w.pairId)).not.toBeNull();
  } finally { w.store.close(); await bounded.close(); }
});

it('survives failed storage without interrupting an unknown-order freeze or hedging', async () => {
  const { dir, observation, w } = await setup();
  await observation.close();
  const bad = path.join(dir, 'not-a-directory');
  await writeFile(bad, 'keep');
  const alerts: string[] = [];
  const failed = new EngineObservation(bad, m => alerts.push(m));
  w.deps.observation = failed;
  try {
    w.venue.nextCreate.push('unknown-delivered');
    await w.step();
    expect(w.store.listOrders(w.pairId)[0].state).toBe('PENDING');
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    await w.step();
    assertInvariants(w);
    await failed.flush();
    expect(failed.stats().writeFailures).toBeGreaterThan(0);
    expect(failed.stats().evidence).toBe('UNKNOWN');
    expect(failed.stats().bufferedBytes).toBe(0);
    await new Promise(resolve => setImmediate(resolve));
    expect(alerts).toHaveLength(1);
    expect(w.venue.createCalls).toHaveLength(2);
  } finally { w.store.close(); await failed.close(); }
});

it('keeps cumulative confirmation distinct from venue fill identity and never treats B reservation as a fill', async () => {
  const { dir, observation, w } = await setup();
  try {
    await w.step();
    w.venue.nextCreate.push('unknown-lost');
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    await w.step();
    await w.step();
    await w.step();
    await observation.flush();
    const rows = await events(dir);
    const projection = rows.filter(e => e.stage === 'projection').at(-1);
    expect(projection.bReserved).toBe('0.05');
    expect(projection.bFilled).toBe('0');
    expect(projection.actualExposureStatus).toBe('UNKNOWN');
    expect(projection.outcome).toBe('unknown');
    expect(rows.filter(e => e.stage === 'fill-confirmed' && e.leg === 'A')).toHaveLength(1);
    expect(rows.find(e => e.stage === 'receipt' && e.operation === 'create' && e.leg === 'B').outcome).toBe('unknown');
    const status = JSON.parse(await readFile(path.join(dir, 'status.json'), 'utf8'));
    expect(status.evidence).toBe('COMPLETE');
    expect(status.bufferedBytes).toBe(0);
    expect(rows.find(e => e.stage === 'decision' && e.action === 'idle').reasonCode).toBe('order-in-doubt');
  } finally { w.store.close(); await observation.close(); }
});

it('continues trading while evidence disk IO is unresolved, then drains within the buffer budget', async () => {
  const { dir, observation, w } = await setup();
  const realPost = Worker.prototype.postMessage;
  let release!: () => void;
  let started = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(function (this: Worker, message) {
    started = true;
    void blocked.then(() => realPost.call(this, message));
  });
  try {
    await w.step();
    const drain = observation.flush();
    await vi.waitFor(() => expect(started).toBe(true));
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    await w.step();
    assertInvariants(w);
    expect(w.venue.createCalls).toHaveLength(2);
    expect(observation.stats().bufferedBytes).toBeGreaterThan(0);
    expect(observation.stats().bufferedBytes).toBeLessThanOrEqual(1024 * 1024);
    release();
    await drain;
    await observation.flush();
    expect(observation.stats().bufferedBytes).toBe(0);
    expect((await events(dir)).some(e => e.stage === 'registered' && e.leg === 'B')).toBe(true);
  } finally { release(); post.mockRestore(); w.store.close(); await observation.close(); }
});

it('keeps monotonic timing and UNKNOWN source evidence when the local wall clock jumps', async () => {
  const { dir, observation, w } = await setup();
  const wall = vi.spyOn(Date, 'now');
  try {
    await observation.tickPair('deal', async scope => {
      wall.mockReturnValue(2000000);
      recordObservation(scope, 'decision', { action: 'idle' });
      wall.mockReturnValue(1000000);
      recordObservation(scope, 'decision', { action: 'idle' });
    });
    wall.mockRestore();
    await observation.flush();
    const rows = (await events(dir)).filter(e => e.stage === 'decision');
    expect(rows[1].utcMs).toBeLessThan(rows[0].utcMs);
    expect(rows[1].monoMs).toBeGreaterThanOrEqual(rows[0].monoMs);
    expect(rows.map(e => [e.sourceTime, e.sourceTimeStatus, e.clockErrorMs])).toEqual([[null, 'UNKNOWN', null], [null, 'UNKNOWN', null]]);
  } finally { wall.mockRestore(); w.store.close(); await observation.close(); }
});

it('keeps rate limits and definite rejections distinct without persisting errors or request payloads', async () => {
  const { dir, observation, w } = await setup();
  try {
    await observation.tickPair('deal', async scope => {
      await expect(observeCall(scope, 'sdk-order-read', {}, async () => {
        throw { response: { status: 429, data: { key: 'SECRET_KEY' } }, message: 'SECRET_KEY' };
      })).rejects.toMatchObject({ response: { status: 429 } });
      expect(await observeCall(scope, 'create', {}, async () => ({ kind: 'reject', label: 'SIZE_TOO_SMALL', message: 'SECRET_KEY' }))).toMatchObject({ kind: 'reject' });
    });
    await observation.flush();
    const rows = await events(dir);
    expect(rows.find(e => e.operation === 'sdk-order-read' && e.stage === 'receipt')).toMatchObject({ outcome: 'unknown', httpStatus: 429, errorCategory: 'rate-limit' });
    expect(rows.find(e => e.operation === 'create' && e.stage === 'receipt').outcome).toBe('reject');
    expect(JSON.stringify(rows)).not.toContain('SECRET_KEY');
  } finally { w.store.close(); await observation.close(); }
});

it('keeps trading when worker creation exhausts host resources', async () => {
  const { dir, observation, w } = await setup();
  await observation.close();
  const alerts: string[] = [];
  faults.workerUnavailable = true;
  const unavailable = new EngineObservation(dir, message => alerts.push(message));
  faults.workerUnavailable = false;
  w.deps.observation = unavailable;
  try {
    await w.step();
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    await w.step();
    assertInvariants(w);
    expect(w.venue.createCalls).toHaveLength(2);
    expect(unavailable.stats().writeFailures).toBe(1);
    expect(unavailable.stats().evidence).toBe('UNKNOWN');
    await new Promise(resolve => setImmediate(resolve));
    expect(alerts).toHaveLength(1);
  } finally { faults.workerUnavailable = false; w.store.close(); await unavailable.close(); }
});

it('never writes a single batch beyond the configured detail disk cap', async () => {
  const { dir, observation, w } = await setup();
  await observation.close();
  const tiny = new EngineObservation(dir, () => {}, { bufferBytes: 1024 * 1024, detailBytes: 100, detailAgeMs: 86400000 });
  try {
    await tiny.tickPair('deal', async scope => {
      for (let i = 0; i < 20; i++) recordObservation(scope, 'decision', { action: 'idle' });
    });
    await tiny.flush();
    const files = (await readdir(path.join(dir, 'details'))).filter(f => f.startsWith('obs-'));
    const sizes = await Promise.all(files.map(f => stat(path.join(dir, 'details', f))));
    expect(sizes.reduce((n, s) => n + s.size, 0)).toBeLessThanOrEqual(100);
    expect(tiny.stats().dropped).toBeGreaterThan(0);
    expect(tiny.stats().evidence).toBe('UNKNOWN');
  } finally { w.store.close(); await tiny.close(); }
});

it('abandons stalled observation work after its deadline while trading remains available', async () => {
  const { observation, w } = await setup();
  await observation.flush();
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await w.step();
    const drain = observation.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await drain;
    expect(observation.stats()).toMatchObject({ evidence: 'UNKNOWN', bufferedBytes: 0, writeFailures: 1 });
    w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.05');
    await w.step();
    assertInvariants(w);
    expect(w.venue.createCalls).toHaveLength(2);
  } finally { vi.useRealTimers(); post.mockRestore(); w.store.close(); await observation.close(); }
});

it('bounds identifier reuse and pending evidence together over repeated distinct orders', async () => {
  const { observation, w } = await setup();
  try {
    for (let batch = 0; batch < 20; batch++) {
      await observation.tickPair('deal', async scope => {
        for (let i = 0; i < 50; i++) recordObservation(scope, 'registered', {
          client: `client-${batch}-${i}`, order: `order-${batch}-${i}`, quantity: '1',
        });
      });
      const pending = observation.stats();
      expect(pending.bufferedBytes + pending.idCacheBytes).toBeLessThanOrEqual(1024 * 1024);
      await observation.flush();
    }
    const stats = observation.stats();
    expect(stats.idCacheBytes).toBeGreaterThan(0);
    expect(stats.idCacheBytes).toBeLessThanOrEqual(64 * 1024);
    expect(stats).toMatchObject({ bufferedBytes: 0, evidence: 'COMPLETE', dropped: 0 });
  } finally { w.store.close(); await observation.close(); }
});
