import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { marketAcc, raw } from '../helpers/boros-fixtures';
import { borosStub } from '../helpers/boros-stub';
import { HOST, makeTestApp, mockGateGet } from './helpers/gate-nock';

const ROOT = '0x1111111111111111111111111111111111111111';
const OPEN = Math.floor(Date.now() / 1000) - 86_400;
// Synthetic amounts preserve the fee-window and decimal-precision regression.
const FEE = '400000000000000';
const SIZE = '2000000000000000123';
const venues = ['Hyperliquid', 'Binance'];

function bodies(root = ROOT, opened = OPEN): Record<string, unknown> {
  const acc = marketAcc(root, 2);
  return {
    '/apis/v1/markets': { results: venues.map((venue, i) => ({
      marketId: 128 + i, tokenId: 2,
      imData: { name: `${venue} ETH`, maturity: OPEN + 90 * 86_400 },
      extConfig: { settleFeeRate: raw(0.001), paymentPeriod: 3600 },
      config: { status: 2 }, platform: { platformId: venue }, metadata: { underlyingSymbol: 'ETH' },
      data: { markApr: 0.06, floatingApr: 0.06, assetMarkPrice: 2500 },
    })), total: 2, skip: 0 },
    '/apis/v1/accounts/market-acc-infos-by-root': { results: [{
      marketAcc: acc, netBalance: raw(1), initialMargin: raw(0.1),
      positions: venues.map((_, i) => ({ marketId: 128 + i, signedSize: i ? SIZE : `-${SIZE}`,
        initialMargin: raw(0.05), maintMargin: raw(0.02), orders: [] })),
    }] },
    '/apis/v1/accounts/active-positions': { results: venues.map((_, i) => ({
      marketAcc: acc, marketId: 128 + i, side: i ? 0 : 1,
      signedSize: i ? SIZE : `-${SIZE}`, fixedApr: i ? 0.04 : 0.08,
      unrealisedPnl: '0', settlementPnl: '0',
    })) },
    '/apis/v1/accounts/settlement-events': { results: [], resumeToken: null },
    ...Object.fromEntries(venues.map((_, i) => [`/apis/v1/accounts/position-update-events?marketId=${128 + i}`, {
      results: [{ id: `open-${i}`, marketId: 128 + i, timestamp: opened,
        fee: FEE, pnl: `-${FEE}`, tradeRate: i ? 0.04 : 0.08,
        prevPositionS: '0', postPositionS: i ? SIZE : `-${SIZE}` }], resumeToken: null,
    }])),
  };
}

function gate(user = '1001', opened = OPEN + 25) {
  mockGateGet('/positions', { body: venues.map((venue, i) => ({
    symbol: `${venue.toUpperCase()}_FUTURE_ETH_${i ? 'USDT' : 'USDC'}`,
    position_side: i ? 'LONG' : 'SHORT', position_qty: '2', position_value: '5000',
    entry_price: '2500', mark_price: '2500', leverage: '25', upnl: '0', funding_fee: '0',
    fee: i ? '-1' : '-2.4', initial_margin: '400',
    create_time: String(opened * 1000), user_id: user,
  })) });
  mockGateGet('/history_positions', { body: [] });
  for (const endpoint of ['/history_margin_interests', '/account_book', '/history_trades']) {
    mockGateGet(endpoint, { body: [] }).persist();
  }
}

let app: FastifyInstance;
let dir: string;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function start(wire = bodies()) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'positions-tracking-'));
  app = makeTestApp({ dataDir: dir, borosFetch: borosStub(wire) });
}

async function read(query = '', root = ROOT) {
  const res = await app.inject({ method: 'GET', url: `/api/asset-view/${root}?fresh=1${query}`, headers: HOST });
  expect(res.statusCode).toBe(200);
  return res.json().data;
}

describe('Positions default tracking window', () => {
  it('repairs a saved Gate-only start and includes both Boros fees paid 25 seconds earlier', async () => {
    start();
    fs.writeFileSync(path.join(dir, 'tracking-start.json'), JSON.stringify({ userId: '1001', firstOpenMs: (OPEN + 25) * 1000 }));
    gate();
    const view = await read();
    expect(view.defaultSinceSec).toBe(OPEN);
    expect(view.sinceSec).toBe(OPEN);
    const history = view.assets[0].borosHistory;
    expect(history).toHaveLength(2);
    for (const leg of history) expect(leg.tradeFeeUsd).toBeCloseTo(1, 12);
  });

  it('keeps corrected starts isolated across wallets and Gate accounts, including a restart', async () => {
    const other = '0x2222222222222222222222222222222222222222';
    const wire = bodies();
    start(wire);
    gate();
    expect((await read()).trackingStart.corrected).toBe(true);
    await app.close();
    app = makeTestApp({ dataDir: dir, borosFetch: borosStub(bodies(other, OPEN + 100)) });
    gate();
    const secondWallet = await read('', other);
    expect(secondWallet.defaultSinceSec).toBe(OPEN + 25);
    expect(secondWallet.trackingStart.corrected).toBe(false);
    await app.close();
    app = makeTestApp({ dataDir: dir, borosFetch: borosStub(wire) });
    gate('1002', OPEN - 300);
    expect((await read()).defaultSinceSec).toBe(OPEN - 300);
    gate();
    const returned = await read();
    expect(returned.defaultSinceSec).toBe(OPEN);
    expect(returned.trackingStart.corrected).toBe(true);
    expect(returned.assets[0].borosHistory[0].tradeFeeUsd).toBeCloseTo(1, 12);
  });

  it('marks a missing position-chain opening as incomplete instead of a free entry', async () => {
    const wire = bodies();
    wire['/apis/v1/accounts/position-update-events?marketId=128'] = { results: [], resumeToken: null };
    start(wire);
    gate();
    const view = await read();
    expect(view.trackingStart.complete).toBe(false);
    expect(view.assets[0].borosOpen.find((p: { marketId: number }) => p.marketId === 128).tradeFeesComplete).toBe(false);
    expect(view.warnings.join(' ')).toMatch(/incomplete/i);
  });

  it('excludes a closed earlier cycle on the same market and preserves explicit windows', async () => {
    const wire = bodies();
    const page = wire['/apis/v1/accounts/position-update-events?marketId=128'] as { results: Record<string, unknown>[] };
    page.results.push(
      { ...page.results[0], id: 'old-close', timestamp: OPEN - 100, fee: raw(0.01), pnl: raw(0.01), prevPositionS: `-${SIZE}`, postPositionS: '0' },
      { ...page.results[0], id: 'old-open', timestamp: OPEN - 200, fee: raw(0.01), pnl: raw(-0.01) },
    );
    start(wire);
    gate();
    const current = await read();
    expect(current.defaultSinceSec).toBe(OPEN);
    expect(current.assets[0].borosHistory.find((h: { marketId: number }) => h.marketId === 128).tradeFeeUsd).toBeCloseTo(1, 12);
    gate();
    const explicit = await read(`&since=${OPEN + 25}`);
    expect(explicit.sinceSec).toBe(OPEN + 25);
    expect(explicit.assets[0].borosHistory).toHaveLength(0);
    gate();
    const oneLeg = await read(`&legSince=128:${OPEN + 25}`);
    expect(oneLeg.assets[0].borosHistory.map((h: { marketId: number }) => h.marketId)).toEqual([129]);
    gate();
    expect((await read()).assets[0].borosHistory).toHaveLength(2);
  });

  it('degrades an upstream fee-history failure and recovers on a fresh read', async () => {
    const wire = bodies();
    delete wire['/apis/v1/accounts/position-update-events?marketId=128'];
    start(wire);
    gate();
    const partial = await read();
    expect(partial.trackingStart.complete).toBe(false);
    expect(partial.coverage.borosTxnsComplete).toBe(false);
    Object.assign(wire, bodies());
    gate();
    const complete = await read();
    expect(complete.trackingStart.complete).toBe(true);
    expect(complete.warnings.join(' ')).not.toMatch(/fee history is incomplete/);
    expect(complete.assets[0].borosHistory).toHaveLength(2);
  });

  it('does not call an omitted fee a zero fee', async () => {
    const wire = bodies();
    const page = wire['/apis/v1/accounts/position-update-events?marketId=128'] as { results: Record<string, unknown>[] };
    delete page.results[0].fee;
    start(wire);
    gate();
    const view = await read();
    expect(view.trackingStart.complete).toBe(false);
    expect(view.assets[0].borosOpen.find((p: { marketId: number }) => p.marketId === 128).tradeFeesComplete).toBe(false);
  });

  it('marks a paginated history that reaches its page cap as incomplete', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const wire = bodies();
    const fallback = borosStub(wire);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'positions-tracking-'));
    app = makeTestApp({ dataDir: dir, borosFetch: async (url) => {
      vi.setSystemTime(Date.now() + 10_000);
      if (new URL(url).pathname.endsWith('/position-update-events') && new URL(url).searchParams.get('marketId') === '128') {
        const page = wire['/apis/v1/accounts/position-update-events?marketId=128'] as { results: unknown[] };
        return { ok: true, status: 200, json: async () => ({ ...page, resumeToken: 'more' }) };
      }
      return fallback(url);
    } });
    gate();
    const view = await read();
    expect(view.coverage.borosTxnsComplete).toBe(false);
    expect(view.trackingStart.complete).toBe(false);
    expect(view.assets[0].borosOpen.find((p: { marketId: number }) => p.marketId === 128).tradeFeesComplete).toBe(false);
  });

  it('does not count an old close in the same second as the new opening', async () => {
    const wire = bodies();
    const page = wire['/apis/v1/accounts/position-update-events?marketId=128'] as { results: Record<string, unknown>[] };
    page.results.push({ ...page.results[0], id: 'old-close-same-second', fee: raw(0.01),
      pnl: raw(0.01), prevPositionS: `-${SIZE}`, postPositionS: '0' });
    start(wire);
    gate();
    const view = await read();
    expect(view.trackingStart.complete).toBe(true);
    expect(view.assets[0].borosHistory.find((h: { marketId: number }) => h.marketId === 128).tradeFeeUsd).toBeCloseTo(1, 12);
  });

  it('does not infer an opening from an omitted pre-fill position', async () => {
    const wire = bodies();
    const page = wire['/apis/v1/accounts/position-update-events?marketId=128'] as { results: Record<string, unknown>[] };
    delete page.results[0].prevPositionS;
    start(wire);
    gate();
    expect((await read()).trackingStart.complete).toBe(false);
  });

  it('keeps the confirmed start across a restart and history failure, then recovers completeness', async () => {
    start();
    gate();
    expect((await read()).defaultSinceSec).toBe(OPEN);
    await app.close();
    const wire = bodies();
    delete wire['/apis/v1/accounts/position-update-events?marketId=128'];
    delete wire['/apis/v1/accounts/position-update-events?marketId=129'];
    app = makeTestApp({ dataDir: dir, borosFetch: borosStub(wire) });
    gate();
    const failed = await read();
    expect(failed.defaultSinceSec).toBe(OPEN);
    expect(failed.trackingStart.complete).toBe(false);
    Object.assign(wire, bodies());
    gate();
    const recovered = await read();
    expect(recovered.defaultSinceSec).toBe(OPEN);
    expect(recovered.trackingStart.complete).toBe(true);
  });
});
