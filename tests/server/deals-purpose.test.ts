/**
 * POST /api/deals declares its purpose (ticket 19): old clients cannot open,
 * closes stay open to every client, a Boros-strategy open keeps its original
 * behavior only with its Boros context, and a stand-alone ('manual') open is
 * refused — before any leverage is touched — wherever the contracts it adds
 * to are already held or working.
 */
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import type { PairRow } from '../../src/engine/types';
import { manualGate } from '../../src/server/manualConflicts';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from '../unit/engine-sim';
import { gate, HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  nock.cleanAll();
});

function simRules(): unknown[] {
  const row = (symbol: string) => ({
    symbol, state: 'live', business_type: 'FUTURE', lot_size: '0.001', min_size: '0', min_notional: '0',
    tick_size: '0.01', max_market_size: '10000', max_limit_size: '10000',
  });
  return [row(A_CONTRACT), row(B_CONTRACT)];
}

function mkApp(): { store: Store; venue: FakeVenue } {
  const store = new Store(':memory:');
  const venue = new FakeVenue();
  app = makeTestApp({ engine: { store, venue, clock: new VirtualClock() } });
  return { store, venue };
}

const BOROS = { base: 'ETH', venues: ['BINANCE', 'OKX'], route: 'singles' };

const payload = (over?: Record<string, unknown>) => ({
  id: 'deal-purpose-1',
  a: { symbol: A_CONTRACT, side: 'BUY' },
  b: { symbol: B_CONTRACT, side: 'SELL' },
  qty: '0.152',
  execution: 'maker',
  price: '2500',
  pricePolicy: 'fixed',
  ...over,
});

const post = (body: object) => app.inject({ method: 'POST', url: '/api/deals', headers: HOST, payload: body });

/** Rules + account for resolveDeal; the gate reads are mocked per test. */
function mockCreate(): void {
  mockGateGet('/rule/symbols', { body: simRules() });
  mockGateGet('/accounts', { fixture: 'account.json' });
}

/** Leverage reads/sets for both legs (risk limits, previous value, the set). */
function mockLeverage(): void {
  mockGateGet('/rule/risk_limits', {
    body: [A_CONTRACT, B_CONTRACT].map((symbol) => ({ symbol, tiers: [{ leverage_max: '50' }] })),
    times: 2,
  });
  gate().get(/positions\/leverage/).times(4).reply(200, {});
  gate().post(/positions\/leverage/).times(4).reply(200, { leverage: '3' });
}

function activeDeal(store: Store, contract: string): void {
  store.createPair({
    id: 'other-deal', mode: 'OPENING',
    a: { contract, side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' }, b: null,
    targetQty: '0.1', limitPrice: '2500', pricePolicy: 'fixed', autoPricePolicy: 'touch', deadlineAt: null,
    makerNotBefore: 0, hedgeNotBefore: 0, pocRejects: 0, hedgeRejectStreak: 0, repriceCount: 0,
    lastMakerPlacementAt: 0, postOnlyRejects: 0, bookOutageStartedAt: 0, maxClip: null, clipBandBp: null,
    haltReason: null, reportJson: null, createdAt: 1,
  } satisfies PairRow);
}

describe('purpose gate', () => {
  it('refuses an opening request from an outdated client before reading anything', async () => {
    const { store } = mkApp();
    const res = await post(payload());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ category: 'validation', label: 'client-outdated' });
    expect(store.getPair('deal-purpose-1')).toBeNull();
  });

  it('accepts a close from an outdated client, still proven against the live position', async () => {
    const { store } = mkApp();
    mockGateGet('/rule/symbols', { body: simRules(), times: 2 });
    mockGateGet('/accounts', { fixture: 'account.json', times: 2 });
    mockGateGet('/positions', { body: [{ symbol: A_CONTRACT, position_qty: '0.5', mark_price: '2500' }], times: 4 });
    const close = { id: 'close-1', a: { symbol: A_CONTRACT, side: 'SELL', reduceOnly: true }, qty: '0.1', execution: 'taker', clipBandPct: 0.5 };
    expect((await post(close)).statusCode).toBe(202);
    expect(store.getPair('close-1')).toMatchObject({ purpose: 'reduce', purposeContext: null });
    // A reduce label does not vouch for itself: nothing to reduce on B.
    const bogus = await post({ ...close, id: 'close-2', purpose: 'reduce', a: { symbol: B_CONTRACT, side: 'SELL', reduceOnly: true } });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error.message).toMatch(/no open position/);
    expect(store.getPair('close-2')).toBeNull();
  });

  it('keeps the original Boros-strategy behavior and records its context', async () => {
    const { store } = mkApp();
    mockCreate();
    const res = await post(payload({ purpose: 'boros-strategy', boros: BOROS }));
    expect(res.statusCode, res.body).toBe(202);
    const pair = store.getPair('deal-purpose-1')!;
    expect(pair.purpose).toBe('boros-strategy');
    expect(JSON.parse(pair.purposeContext!)).toEqual(BOROS);
  });

  it('refuses a Boros-strategy open without its context, creating nothing', async () => {
    const { store } = mkApp();
    const res = await post(payload({ purpose: 'boros-strategy' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.label).toBe('boros-context-invalid');
    expect(store.listPairs()).toEqual([]);
  });

  it('refuses a Boros context for another coin — a forged label does not pass as the strategy', async () => {
    const { store } = mkApp();
    const res = await post(payload({ purpose: 'boros-strategy', boros: { ...BOROS, base: 'BTC' } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.label).toBe('boros-context-invalid');
    expect(store.listPairs()).toEqual([]);
  });

  it('never accepts a funding-opportunity open as a plain deal', async () => {
    const { store } = mkApp();
    const res = await post(payload({ purpose: 'funding-two-leg' }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.label).toBe('funding-admission-required');
    expect(store.listPairs()).toEqual([]);
  });

  it('answers a retry of an accepted deal with its receipt, whatever the retry carries', async () => {
    const { store } = mkApp();
    mockCreate();
    expect((await post(payload({ purpose: 'boros-strategy', boros: BOROS }))).statusCode).toBe(202);
    const retry = await post(payload());
    expect(retry.statusCode).toBe(202);
    expect(retry.json().data).toEqual({ id: 'deal-purpose-1', duplicate: true });
    expect(store.listPairs()).toHaveLength(1);
  });
});

describe('manual conflict gate', () => {
  const manual = (over?: Record<string, unknown>) => payload({ purpose: 'manual', leverage: { a: 3, b: 3 }, ...over });

  it('admits a stand-alone open where nothing is held or working', async () => {
    const { store } = mkApp();
    mockCreate();
    mockGateGet('/positions', { body: [{ symbol: 'GATE_FUTURE_BTC_USDT', position_qty: '1' }] });
    mockGateGet('/open_orders', { body: [] });
    mockLeverage();
    const res = await post(manual());
    expect(res.statusCode, res.body).toBe(202);
    expect(store.getPair('deal-purpose-1')).toMatchObject({ purpose: 'manual', purposeContext: null });
  });

  it.each([
    ['a position whose owner is unproven', () => mockGateGet('/positions', { body: [{ symbol: B_CONTRACT, position_qty: '-0.2' }] }), /position is already open/],
    ['an open venue order', () => mockGateGet('/open_orders', { body: [{ symbol: A_CONTRACT, order_id: '9' }] }), /open order is already working/],
  ])('refuses next to %s, before touching leverage', async (_name, arrange, message) => {
    const { store } = mkApp();
    mockCreate();
    arrange();
    mockGateGet('/positions', { body: [] });
    mockGateGet('/open_orders', { body: [] });
    const leverage = gate().post(/leverage/).reply(200, { leverage: '3' });
    const res = await post(manual());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ label: 'manual-conflict' });
    expect(res.json().error.message).toMatch(message);
    expect(leverage.isDone()).toBe(false);
    expect(store.getPair('deal-purpose-1')).toBeNull();
  });

  it('refuses next to an unfinished deal on the same contract', async () => {
    const { store } = mkApp();
    mockCreate();
    activeDeal(store, B_CONTRACT);
    const res = await post(manual());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('other-deal');
    expect(store.getPair('deal-purpose-1')).toBeNull();
  });

  it('refuses when positions cannot be read — an unknown is never a pass', async () => {
    const { store } = mkApp();
    mockCreate();
    mockGateGet('/positions', { status: 500, body: { label: 'SERVER_ERROR' } });
    mockGateGet('/open_orders', { body: [] });
    const res = await post(manual());
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ category: 'network', label: 'manual-unverifiable', retryable: true });
    expect(store.getPair('deal-purpose-1')).toBeNull();
  });

  it('treats a body that is not a list as unreadable, never as "none held"', async () => {
    const store = new Store(':memory:');
    const gated = await manualGate([A_CONTRACT], {
      store,
      readPositions: async () => [],
      readOpenOrders: async () => ({ message: 'maintenance' }),
    });
    expect(gated).toMatchObject({ ok: false, label: 'manual-unverifiable' });
    expect(await manualGate([A_CONTRACT], { store, readPositions: async () => [{ symbol: A_CONTRACT, positionQty: 'n/a' }], readOpenOrders: async () => [] }))
      .toMatchObject({ ok: false, label: 'manual-conflict' }); // an unreadable size counts as held
  });

  it('re-checks for a deal that started while the gate was reading, with no await before the write', async () => {
    const { store } = mkApp();
    mockCreate();
    gate().get('/api/v4/crossex/positions').query(true).reply(200, () => {
      activeDeal(store, A_CONTRACT); // lands mid-request
      return [];
    });
    mockGateGet('/open_orders', { body: [] });
    mockLeverage();
    const res = await post(manual());
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toContain('other-deal');
    expect(store.getPair('deal-purpose-1')).toBeNull();
  });
});
