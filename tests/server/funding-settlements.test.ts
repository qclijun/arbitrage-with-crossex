import { afterEach, expect, it } from 'vitest';
import { boardWorld, type BoardWorld } from '../helpers/funding-board-fixture';
import { flat, historyLeg, publish } from '../helpers/funding-ranking-fixture';
import { HOST } from './helpers/gate-nock';
import { OKX_ARCHIVE_API } from '../../src/core/funding/history-sources';

let world: BoardWorld | undefined;
afterEach(async () => { await world?.app.close(); world?.store.close(); world = undefined; });
const native = [
  { venue: 'ASTER', contractId: 'BTCUSDT', symbol: 'ASTER_FUTURE_BTC_USDT' },
  { venue: 'HYPERLIQUID', contractId: 'BTC', symbol: 'HYPERLIQUID_FUTURE_BTC_USDC' },
  { venue: 'OKX', contractId: 'BTC-USDT-SWAP', symbol: 'OKX_FUTURE_BTC_USDT' },
];

it('serves five observed windows for unpaired native products without granting ranking eligibility or fetching', async () => {
  const legs = native.map((row) => {
    const leg = historyLeg(row.venue, row.contractId, flat('0.0001'));
    leg.rules = [];
    leg.listing = null;
    leg.events.forEach((event) => { event.intervalHours = null; });
    if (row.venue === 'HYPERLIQUID') leg.source.api = 'info:fundingHistory';
    if (row.venue === 'OKX') leg.source.api = OKX_ARCHIVE_API;
    return leg;
  });
  world = await boardWorld({ history: publish(legs), listings: native.map((row) => ({ ...row, underlying: null, rateBasis: null })) });
  const calls = [...world.sourceCalls];
  for (let n = 0; n < 2; n += 1) {
    const response = await world.app.inject({ method: 'GET', url: '/api/funding/settlements?underlying=BTC', headers: HOST });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.matched).toBe(3);
    expect(data.rows.map((row: any) => row.venue)).toEqual(['ASTER', 'HYPERLIQUID', 'OKX']);
    for (const row of data.rows) {
      expect(row.windows.map((window: any) => window.days)).toEqual([7, 30, 90, 180, 365]);
      expect(row.windows[4]).toMatchObject({ coverage: 'unknown', annualized: null,
        observed: { events: 1095, total: '0.1095', annualized: '0.1095' } });
    }
  }
  expect(world.sourceCalls).toEqual(calls);
  expect((await world.get()).body.data).toMatchObject({ candidateCount: 0, rankedCount: 0, admission: { open: false } });
});

it('paginates native contracts, validates bounds and keeps a cold start empty instead of zero', async () => {
  world = await boardWorld();
  const filtered = await world.app.inject({ method: 'GET', url: '/api/funding/settlements?venue=OKX&limit=1&offset=1', headers: HOST });
  expect(filtered.json().data).toMatchObject({ matched: 2, limit: 1, offset: 1, rows: [{ contractId: 'ETH-USDT-SWAP',
    windows: expect.arrayContaining([expect.objectContaining({ coverage: 'unavailable', observed: null, total: null })]) }] });
  for (const query of ['limit=0', 'limit=201', 'offset=-1', 'offset=1.2']) {
    const response = await world.app.inject({ method: 'GET', url: `/api/funding/settlements?${query}`, headers: HOST });
    expect(response.statusCode).toBe(400);
  }
});
