import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { commands, tickPair } from '../../src/engine/loop';
import { fx } from '../../src/engine/fx';
import { TUNING } from '../../src/engine/types';
import { A_CONTRACT, B_CONTRACT, assertInvariants, mkWorld, type World } from './engine-sim';

const worlds: World[] = [], dirs: string[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(options?: Parameters<typeof mkWorld>[0], fill = '0.05') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-dependency-'));
  dirs.push(dir);
  const w = mkWorld({ pricePolicy: 'best', b: { minNotional: '5' }, ...options, storePath: path.join(dir, 'deals.sqlite') });
  worlds.push(w);
  w.deps.skipUnrelatedMakerWait = true;
  await w.step();
  const maker = w.venue.liveOrder(A_CONTRACT)!;
  w.venue.fill(maker.clientText, fill);
  return { w, maker };
}

it('submits a write-ahead B hedge once its required price is ready without waiting on Maker', async () => {
  const { w } = await setup();
  const makerStarted = deferred<string>(), makerPrice = deferred<string | null>();
  const refStarted = deferred<string>(), ref = deferred<string | null>(), hedged = deferred<string>();
  w.venue.bestQuote = async () => { makerStarted.resolve('maker'); return makerPrice.promise; };
  w.venue.refPrice = async () => { refStarted.resolve('reference'); return ref.promise; };
  const create = w.venue.create.bind(w.venue);
  w.venue.create = async req => {
    if (req.contract === B_CONTRACT) {
      expect(w.store.listOrders(w.pairId).find(o => o.clientId === req.clientText)).toMatchObject({ state: 'PENDING', qty: '0.05' });
      hedged.resolve('hedged');
    }
    return create(req);
  };
  const tick = w.step();
  try {
    expect(await Promise.race([refStarted.promise, makerStarted.promise])).toBe('reference');
    ref.resolve('2500');
    expect(await Promise.race([hedged.promise, makerStarted.promise])).toBe('hedged');
    await tick;
    expect(w.venue.createCalls).toHaveLength(2);
    assertInvariants(w);
  } finally { makerPrice.resolve('2500'); ref.resolve('2500'); await tick; }
});

it('hedges in Convert without waiting for the unrelated A clip reference', async () => {
  const { w } = await setup({ a: { minNotional: '5' } });
  commands.convertNow(w.store, w.pairId);
  await w.step(); // Cancel the resting maker first.
  const aStarted = deferred<string>(), aPrice = deferred<string | null>(), hedged = deferred<string>();
  w.venue.refPrice = async contract => {
    if (contract === A_CONTRACT) { aStarted.resolve('A'); return aPrice.promise; }
    return '2500';
  };
  const create = w.venue.create.bind(w.venue);
  w.venue.create = async req => {
    if (req.contract === B_CONTRACT) hedged.resolve('B');
    return create(req);
  };
  const tick = w.step();
  try {
    expect(await Promise.race([hedged.promise, aStarted.promise])).toBe('B');
    await tick;
    expect(w.venue.truth().bTrue).toBe(fx('0.05'));
    assertInvariants(w);
  } finally { aPrice.resolve('2500'); await tick; }
});

it('reports missing B price with quantities, throttles repeats and distinguishes B recovery from Maker recovery', async () => {
  const { w } = await setup();
  w.deps.waitMonotonicNow = w.clock.now;
  w.venue.refPrices.delete(B_CONTRACT);
  const outageStart = w.clock.now() - 10_000;
  w.store.updatePair(w.pairId, { bookOutageStartedAt: outageStart });
  await w.step();
  let alerts = w.store.listAlerts().filter(a => a.message.startsWith('hedge price '));
  expect(alerts).toHaveLength(1);
  expect(alerts[0].message).toContain('unreserved 0.05 base');
  expect(alerts[0].message).toContain('confirmed exposure 0.05 base');
  expect(alerts[0].message).toContain('observed wait 0ms');
  expect(w.store.getPair(w.pairId)!.bookOutageStartedAt).toBe(outageStart);
  await w.step();
  expect(w.store.listAlerts().filter(a => a.message.startsWith('hedge price '))).toHaveLength(1);
  w.clock.advance(30_000);
  await w.step();
  expect(w.store.listAlerts().filter(a => a.message.startsWith('hedge price blocked'))).toHaveLength(2);
  w.venue.refPrices.set(B_CONTRACT, '2500');
  await w.step();
  alerts = w.store.listAlerts().filter(a => a.message.startsWith('hedge price recovered'));
  expect(alerts).toHaveLength(1);
  expect(alerts[0].message).toContain('source time UNKNOWN');
  expect(w.store.getPair(w.pairId)!.bookOutageStartedAt).toBe(outageStart);
  assertInvariants(w);
});

it('independently disables the optimization and restores Maker-before-B reading', async () => {
  const { w } = await setup();
  w.deps.skipUnrelatedMakerWait = false;
  const makerStarted = deferred<void>(), price = deferred<string | null>();
  let bReads = 0;
  w.venue.bestQuote = async () => { makerStarted.resolve(); return price.promise; };
  w.venue.refPrice = async () => { bReads++; return '2500'; };
  const tick = w.step();
  try {
    await makerStarted.promise;
    expect(bReads).toBe(0);
    expect(w.venue.createCalls).toHaveLength(1);
  } finally { price.resolve('2500'); await tick; }
  expect(bReads).toBe(1);
  expect(w.venue.createCalls).toHaveLength(2);
});

it.each(['stop', 'convert', 'reprice', 'quote-mode', 'reference-mode'] as const)(
  'defers the whole context when %s commits during the B price await', async edit => {
    const { w } = await setup();
    w.venue.refPrice = async () => {
      if (edit === 'stop') commands.stop(w.store, w.pairId);
      if (edit === 'convert') commands.convertNow(w.store, w.pairId);
      if (edit === 'reprice') w.store.updatePair(w.pairId, { limitPrice: '2510' });
      if (edit === 'quote-mode') w.store.updatePair(w.pairId, { pricePolicy: 'fixed' });
      if (edit === 'reference-mode') w.store.updatePair(w.pairId, { autoPricePolicy: 'touch' });
      return null;
    };
    await w.step();
    expect(w.venue.createCalls).toHaveLength(1);
    expect(w.store.getPair(w.pairId)!.hedgeRejectStreak).toBe(0);
    expect(w.store.listAlerts().filter(a => a.message.startsWith('hedge price '))).toHaveLength(0);
  });

it.each(['stop', 'convert', 'reprice', 'backoff'] as const)('keeps %s ahead of B placement without reading Maker', async edit => {
  const { w, maker } = await setup();
  if (edit === 'stop') commands.stop(w.store, w.pairId);
  if (edit === 'convert') commands.convertNow(w.store, w.pairId);
  if (edit === 'reprice') w.store.updatePair(w.pairId, { limitPrice: '2510' });
  if (edit === 'backoff') w.store.updatePair(w.pairId, { hedgeNotBefore: w.clock.now() + 30_000 });
  w.venue.bestQuote = async () => { throw new Error('Maker is not a dependency of this cancel'); };
  await w.step();
  expect(w.venue.orders.get(maker.clientText)!.rawStatus).toBe('CANCELLED');
  expect(w.venue.createCalls).toHaveLength(1);
  assertInvariants(w);
});

it('reconfirms orders after B price returns and hedges newly confirmed quantity', async () => {
  const { w, maker } = await setup();
  w.venue.refPrice = async () => { w.venue.fill(maker.clientText, '0.02'); return '2500'; };
  await w.step();
  expect(w.store.listOrders(w.pairId).find(o => o.leg === 'B')).toMatchObject({ qty: '0.07', cumQty: '0.07' });
  assertInvariants(w);
});

it('rechecks commands committed during the post-price order confirmation', async () => {
  const { w } = await setup();
  const getOrder = w.venue.getOrder.bind(w.venue);
  let reads = 0;
  w.venue.getOrder = async ref => {
    if (++reads === 2) commands.stop(w.store, w.pairId);
    return getOrder(ref);
  };
  await w.step();
  expect(reads).toBe(2);
  expect(w.venue.createCalls).toHaveLength(1);
  expect(w.store.getPair(w.pairId)!.mode).toBe('STOPPING');
});

it('captures cancellation-race fills and hedges the final cumulative amount once', async () => {
  const { w } = await setup();
  commands.stop(w.store, w.pairId);
  w.venue.nextCancelRace.push(0.5);
  await w.step();
  expect(w.venue.createCalls).toHaveLength(1);
  await w.step();
  expect(w.store.listOrders(w.pairId).find(o => o.leg === 'B')).toMatchObject({ qty: '0.101', cumQty: '0.101' });
  await w.step();
  expect(w.venue.createCalls).toHaveLength(2);
  assertInvariants(w);
});

it('keeps an old Maker outage through the fast hedge and still cancels at 30 seconds on the next book check', async () => {
  const { w, maker } = await setup();
  const start = w.store.getPair(w.pairId)!.lastMakerPlacementAt;
  w.store.updatePair(w.pairId, { bookOutageStartedAt: start });
  w.clock.advance(TUNING.BOOK_OUTAGE_CANCEL_MS);
  w.venue.bestQuote = async () => null; // Maker-only outage; B book stays valid
  await w.step();
  expect(w.venue.orders.get(maker.clientText)!.rawStatus).toBe('NEW');
  expect(w.store.getPair(w.pairId)!.bookOutageStartedAt).toBe(start);
  await w.step();
  expect(w.venue.orders.get(maker.clientText)!.rawStatus).toBe('CANCELLED');
  expect(w.store.getPair(w.pairId)!.repriceCount).toBe(0);
  assertInvariants(w);
});

it.each(['pending', 'quarantined'] as const)('preserves %s placement freezes and old outage markers', async state => {
  const { w, maker } = await setup();
  if (state === 'pending') {
    w.venue.nextCreate.push('unknown-delivered');
    await w.step();
    w.venue.readsFail = true;
    w.venue.cancelsFail = true;
  } else {
    w.venue.setRawStatus(maker.clientText, 'ALIEN');
  }
  const before = w.venue.createCalls.length;
  const start = w.clock.now();
  w.store.updatePair(w.pairId, { bookOutageStartedAt: start });
  w.venue.bestQuote = async () => { throw new Error('frozen pair must not fetch Maker'); };
  await w.step();
  expect(w.venue.createCalls).toHaveLength(before);
  expect(w.store.getPair(w.pairId)!.bookOutageStartedAt).toBe(start);
  assertInvariants(w);
});

it.each([
  { b: { minNotional: '5', lot: '0.01' }, fill: '0.005' },
  { b: { minNotional: '5', minSize: '0.02' }, fill: '0.01' },
])('does not count submittable-size dust as missing-price failures: $fill', async ({ b, fill }) => {
  const { w } = await setup({ b }, fill);
  w.venue.refPrices.delete(B_CONTRACT);
  await w.step(12);
  expect(w.store.getPair(w.pairId)!.hedgeRejectStreak).toBe(0);
  expect(w.store.getPair(w.pairId)!.mode).toBe('OPENING');
  expect(w.venue.createCalls).toHaveLength(1);
  expect(w.store.listAlerts().some(a => a.message.startsWith('hedge price '))).toBe(false);
  assertInvariants(w);
});

it('does not treat zero reference as dust or bypass minNotional, and retains the original HALT/backoff budget', async () => {
  const { w } = await setup();
  w.venue.refPrices.set(B_CONTRACT, '0');
  await w.step(12);
  expect(w.venue.truth().bTrue).toBe(fx('0'));
  expect(w.store.getPair(w.pairId)!.mode).toBe('HALTED');
  expect(w.store.getPair(w.pairId)!.hedgeRejectStreak).toBeGreaterThanOrEqual(TUNING.HEDGE_REJECT_HALT);
  w.venue.refPrices.set(B_CONTRACT, '2500');
  await w.step(4);
  expect(w.venue.truth().bTrue).toBe(fx('0.05'));
  expect(w.store.getPair(w.pairId)!.mode).toBe('HALTED'); // source recovery does not resume acquisition
  assertInvariants(w);
});

it('preserves a reserved-but-unfilled B exposure in bounded structured observations', async () => {
  const { EngineObservation } = await import('../../src/engine/observation');
  const { w } = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-wait-observations-'));
  dirs.push(dir);
  const observation = new EngineObservation(dir, () => {});
  w.deps.observation = observation;
  w.deps.waitMonotonicNow = w.clock.now;
  const create = w.venue.create.bind(w.venue);
  w.venue.create = async req => {
    const out = await create(req);
    if (req.contract === B_CONTRACT && out.kind === 'ok') {
      const live = w.venue.orders.get(req.clientText)!;
      live.cum = 0n;
      live.rawStatus = 'NEW';
      return { kind: 'ok', snapshot: { ...out.snapshot, rawStatus: 'NEW', cumQty: '0' } };
    }
    return out;
  };
  try {
    w.venue.refPrices.delete(B_CONTRACT);
    await w.step();
    w.clock.advance(TUNING.HEDGE_BACKOFF_MS);
    w.venue.refPrices.set(B_CONTRACT, '2500');
    await w.step(2);
    await observation.flush();
    const rows = fs.readdirSync(path.join(dir, 'details')).flatMap(file =>
      fs.readFileSync(path.join(dir, 'details', file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const blocked = rows.find(row => row.stage === 'hedge-wait' && row.waitState === 'blocked');
    expect(blocked).toMatchObject({ unreserved: '0.05', actualUnhedged: '0.05', waitMs: 0, sourceTimeStatus: 'UNKNOWN' });
    expect(rows.find(row => row.stage === 'hedge-wait' && row.waitState === 'recovered')).toMatchObject({ actualUnhedged: '0.05' });
    expect(rows.some(row => row.stage === 'projection' && row.aFilled === '0.05' && row.bFilled === '0' &&
      row.bReserved === '0.05' && row.unreserved === '0')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(w.pairId + '"');
    expect(observation.stats().dropped).toBe(0);
    assertInvariants(w);
  } finally { await observation.close(); }
});

it('labels unverified reserved orders UNKNOWN and does not claim source recovery', async () => {
  const { w } = await setup();
  w.venue.refPrices.delete(B_CONTRACT);
  await w.step();
  // Persist a write-ahead reservation whose request outcome is unknown.
  w.store.insertPendingOrder({ pairId: w.pairId, leg: 'B', kind: 'taker', side: 'SELL', price: null,
    qty: '0.05', tif: 'ioc', now: w.clock.now() });
  await w.step();
  const ended = w.store.listAlerts().find(a => a.message.startsWith('hedge price not-required'));
  expect(ended?.message).toContain('unreserved 0 base');
  expect(ended?.message).toContain('confirmed exposure UNKNOWN base');
  expect(ended?.message).toContain('source recovery unverified');
  expect(w.store.listAlerts().some(a => a.message.startsWith('hedge price recovered'))).toBe(false);
});

it('does not let a wait-report failure prevent a safe hedge', async () => {
  const { w } = await setup();
  w.venue.refPrices.delete(B_CONTRACT);
  w.store.alert = () => { throw new Error('diagnostic write failed'); };
  await w.step();
  w.clock.advance(TUNING.HEDGE_BACKOFF_MS);
  w.venue.refPrices.set(B_CONTRACT, '2500');
  await w.step();
  expect(w.venue.truth().bTrue).toBe(fx('0.05'));
  assertInvariants(w);
});

it('keeps wait duration UNKNOWN after a diagnostic clock regression', async () => {
  const { w } = await setup();
  let mono = 100;
  w.deps.waitMonotonicNow = () => mono;
  w.venue.refPrices.delete(B_CONTRACT);
  await w.step();
  mono = 50;
  await w.step();
  w.clock.advance(TUNING.HEDGE_BACKOFF_MS);
  w.venue.refPrices.set(B_CONTRACT, '2500');
  await w.step();
  expect(w.store.listAlerts().find(a => a.message.startsWith('hedge price recovered'))?.message)
    .toContain('observed wait UNKNOWN');
});

it('caps active wait diagnostics and reports missing capacity without adding orders', async () => {
  const { w } = await setup();
  let mono = 100;
  w.deps.waitMonotonicNow = () => mono;
  const template = w.store.getPair(w.pairId)!;
  w.venue.refPrices.delete(B_CONTRACT);
  for (let n = 0; n < 257; n++) {
    const id = `wait-capacity-${n}`;
    w.store.createPair({ ...template, id });
    // Historical terminal fill, via the agreed public ledger fixture boundary.
    const filled = w.store.insertPendingOrder({ pairId: id, leg: 'A', kind: 'taker', side: 'BUY',
      price: null, qty: '0.05', tif: 'ioc', now: w.clock.now() });
    w.store.updateOrder(id, 'A', filled.seq, { state: 'CLOSED', cumQty: '0.05', closeReason: 'filled' });
    await tickPair(w.deps, id);
  }
  const alerts = w.store.listAlerts();
  expect(alerts.filter(a => a.message.startsWith('hedge price blocked'))).toHaveLength(256);
  expect(alerts.filter(a => a.message.includes('reporting capacity reached'))).toHaveLength(1);
  expect(alerts.find(a => a.message.includes('reporting capacity reached'))?.message).toContain('UNKNOWN');
  const capacity = alerts.find(a => a.message.includes('reporting capacity reached'))!;
  w.store.ackAlert(capacity.id);
  for (const sample of [101, 50, NaN, 29_999]) {
    mono = sample;
    w.clock.advance(TUNING.HEDGE_BACKOFF_MS);
    await tickPair(w.deps, 'wait-capacity-256');
  }
  expect(w.store.listAlerts().filter(a => a.message.includes('reporting capacity reached'))).toHaveLength(1);
  mono = 30_100;
  w.clock.advance(TUNING.HEDGE_BACKOFF_MS);
  await tickPair(w.deps, 'wait-capacity-256');
  expect(w.store.listAlerts().filter(a => a.message.includes('reporting capacity reached'))).toHaveLength(2);
  expect(w.venue.createCalls).toHaveLength(1);
});
