/**
 * GET /api/funding/opportunities (ticket 18): the read-only ranking page. It
 * reads the published history cache and the in-memory market only: every
 * directed pair, zero/negative/UNKNOWN kept, filters and pages over one
 * global order, and a ranking fingerprint so a browse never mixes two
 * rankings across pages.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { boardWorld, HISTORY, id, type BoardWorld } from '../helpers/funding-board-fixture';
import { publish } from '../helpers/funding-ranking-fixture';
import { HOST, makeTestApp } from './helpers/gate-nock';

let w: BoardWorld;
afterEach(async () => {
  await w?.app.close();
});

const ids = (body: any) => body.data.rows.map((r: any) => r.id);
const ranks = (body: any) => body.data.rows.map((r: any) => r.rank);

const BTC_ORDER = [
  id('BTC', 'BINANCE BTCUSDT', 'BYBIT BTCUSDT'),
  // A true tie at 0.0002, by exact identity.
  id('BTC', 'BINANCE BTCUSDC', 'BYBIT BTCUSDT'),
  id('BTC', 'BINANCE BTCUSDT', 'OKX BTC-USDT-SWAP'),
  id('BTC', 'OKX BTC-USDT-SWAP', 'BYBIT BTCUSDT'),
  id('BTC', 'BINANCE BTCUSDC', 'OKX BTC-USDT-SWAP'),
  id('BTC', 'OKX BTC-USDT-SWAP', 'BINANCE BTCUSDC'),
  // -0.0002 three ways: BYBIT sorts before OKX.
  id('BTC', 'BYBIT BTCUSDT', 'BINANCE BTCUSDC'),
  id('BTC', 'BYBIT BTCUSDT', 'OKX BTC-USDT-SWAP'),
  id('BTC', 'OKX BTC-USDT-SWAP', 'BINANCE BTCUSDT'),
  id('BTC', 'BYBIT BTCUSDT', 'BINANCE BTCUSDT'),
];
const ETH_ROWS = [id('ETH', 'BINANCE ETHUSDT', 'OKX ETH-USDT-SWAP'), id('ETH', 'OKX ETH-USDT-SWAP', 'BINANCE ETHUSDT')];

describe('funding opportunities ranking', () => {
  it('ranks every direction across three venues, same-venue contracts as separate legs, keeping zero, negative and UNKNOWN', async () => {
    w = await boardWorld();
    const res = await w.get();
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data).toMatchObject({ days: 30, compareDays: 7, candidateCount: 12, matched: 12, rankedCount: 10, offset: 0, limit: 50 });
    expect(ids(res.body)).toEqual([...BTC_ORDER, ...ETH_ROWS]);
    expect(ranks(res.body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null, null]);
    const [top] = data.rows;
    expect(top.short).toEqual({ venue: 'BINANCE', contractId: 'BTCUSDT', symbol: 'BINANCE_FUTURE_BTC_USDT' });
    expect(top.windows.map((x: any) => x.days)).toEqual([7, 30, 90, 180, 365]);
    const thirty = top.windows[1];
    expect(thirty).toMatchObject({ eligible: true, coverage: 'complete', netTotal: '0.036', reasons: [] });
    expect(thirty.legs.short).toMatchObject({ coverage: 'complete', fresh: true, total: '0.027', missingEvents: 0, conflicts: 0 });
    expect(thirty.legs.long).toMatchObject({ total: '-0.009' });
    expect(data.rows[4].windows[1].netTotal).toBe('0');
    expect(data.rows[9].windows[1].netTotal).toBe('-0.036');
    const eth = data.rows[10];
    expect(eth.windows[1]).toMatchObject({ eligible: false, coverage: 'unavailable', netTotal: null, legs: null });
    expect(eth.windows[1].reasons).toEqual(['long:history-leg-missing']);
    expect(data.options).toEqual({ underlyings: ['BTC', 'ETH'], venues: ['BINANCE', 'BYBIT', 'OKX'] });
    expect(data.history).toMatchObject({ state: 'ready', snapshotId: 'snap-1', cutoffBehind: false });
    expect(data.contracts).toMatchObject({ state: 'ready', count: 6, unpaired: [] });
  });

  it('filters by coin, venue and positive spread, then pages the global order with global ranks', async () => {
    w = await boardWorld();
    const bybit = await w.get('?venue=BYBIT&positive=1');
    // UNKNOWN, zero and negative are never "positive"; filters leave the candidate set alone.
    expect(ids(bybit.body)).toEqual([BTC_ORDER[0], BTC_ORDER[1], BTC_ORDER[3]]);
    expect(bybit.body.data).toMatchObject({ candidateCount: 12, matched: 3, rankedCount: 3 });
    const eth = await w.get('?underlying=ETH');
    expect(ids(eth.body)).toEqual(ETH_ROWS);
    const first = await w.get('?limit=4');
    const second = await w.get(`?limit=4&offset=4&rankingId=${first.body.data.rankingId}`);
    expect(ids(second.body)).toEqual(BTC_ORDER.slice(4, 8));
    expect(ranks(second.body)).toEqual([5, 6, 7, 8]);
    expect(second.body.data).toMatchObject({ rankingChanged: false, rankingId: first.body.data.rankingId, offset: 4 });
  });

  it('a page asked against a replaced ranking says so and restarts at page one of the new one', async () => {
    w = await boardWorld();
    const first = await w.get('?limit=4');
    // A new snapshot with the same order is still a different ranking: values may differ.
    w.history.publish(publish(HISTORY, 'snap-2').snapshot(), w.history.view(w.clock.now()).lastRound!);
    const next = await w.get(`?limit=4&offset=4&rankingId=${first.body.data.rankingId}`);
    expect(next.body.data).toMatchObject({ rankingChanged: true, offset: 0, snapshotId: 'snap-2' });
    expect(next.body.data.rankingId).not.toBe(first.body.data.rankingId);
    expect(ids(next.body)).toEqual(BTC_ORDER.slice(0, 4));
  });

  it.each([
    ['?days=14', 'days'],
    ['?compare=0', 'compare'],
    ['?limit=0', 'limit'],
    ['?limit=201', 'limit'],
    ['?offset=-1', 'offset'],
    ['?positive=yes', 'positive'],
    ['?rankingId=abc', 'rankingId'],
  ])('refuses %s rather than clamping it', async (query, field) => {
    w = await boardWorld();
    const res = await w.get(query);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(field);
  });

  it('without the opportunities ports it refuses (503) rather than reading venues on request', async () => {
    const app = makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/funding/opportunities', headers: HOST });
    await app.close();
    expect(res.statusCode).toBe(503);
  });
});
