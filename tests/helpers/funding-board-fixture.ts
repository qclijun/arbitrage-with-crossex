/**
 * Offline world for GET /api/funding/opportunities (ticket 18): synthetic
 * settled histories published into the real read-only cache, and the real
 * market poller over counting fake sources, run once before any request. Every
 * rate, contract and listing here is invented; real HTTP stays blocked.
 */
import type { FastifyInstance } from 'fastify';
import { FundingHistoryCache } from '../../src/core/funding/history-cache';
import type { VenueFundingRate } from '../../src/core/funding/feeds';
import { createFundingMarket, type FundingContractListing, type FundingMarket } from '../../src/core/funding/market';
import { Store } from '../../src/engine/db';
import { FakeVenue, VirtualClock } from '../unit/engine-sim';
import { HOST, makeTestApp } from '../server/helpers/gate-nock';
import { fakeReads, readState } from './funding-intent-fixture';
import { CUTOFF, NOW, flat, historyLeg, live, publish } from './funding-ranking-fixture';

export { CUTOFF, NOW };

const listing = (venue: string, contractId: string, symbol: string | null, underlying = 'BTC'): FundingContractListing =>
  ({ ...live(venue, contractId, underlying), symbol });

/** Three venues, two BTC contracts on Binance, and an ETH pair whose OKX history is missing. */
export const LISTINGS: FundingContractListing[] = [
  listing('BINANCE', 'BTCUSDT', 'BINANCE_FUTURE_BTC_USDT'),
  listing('BINANCE', 'BTCUSDC', null),
  listing('OKX', 'BTC-USDT-SWAP', 'OKX_FUTURE_BTC_USDT'),
  listing('BYBIT', 'BTCUSDT', 'BYBIT_FUTURE_BTC_USDT'),
  listing('BINANCE', 'ETHUSDT', 'BINANCE_FUTURE_ETH_USDT', 'ETH'),
  listing('OKX', 'ETH-USDT-SWAP', 'OKX_FUTURE_ETH_USDT', 'ETH'),
];

/** Per-settlement rates: spreads of 0.0004, 0.0002 (a true tie), 0, and their negatives. */
export const HISTORY = [
  historyLeg('BINANCE', 'BTCUSDT', flat('0.0003')),
  historyLeg('BINANCE', 'BTCUSDC', flat('0.0001')),
  historyLeg('OKX', 'BTC-USDT-SWAP', flat('0.0001')),
  historyLeg('BYBIT', 'BTCUSDT', flat('-0.0001')),
  historyLeg('BINANCE', 'ETHUSDT', flat('0.0002')),
];

export const id = (underlying: string, short: string, long: string) =>
  JSON.stringify([underlying, ...short.split(' '), ...long.split(' ')]);

export interface BoardWorld {
  app: FastifyInstance;
  store: Store;
  venue: FakeVenue;
  clock: VirtualClock;
  history: FundingHistoryCache;
  market: FundingMarket;
  /** Every source read the market made; requests must add none. */
  sourceCalls: string[];
  quotes: Record<string, VenueFundingRate[]>;
  get(query?: string): Promise<{ status: number; body: any }>;
  post(url: string, payload: object): Promise<{ status: number; body: any }>;
}

export async function boardWorld(opts: { history?: FundingHistoryCache; listings?: FundingContractListing[] | null } = {}): Promise<BoardWorld> {
  const clock = new VirtualClock();
  clock.t = NOW;
  const store = new Store(':memory:', { programVersion: '9.9.9' });
  const venue = new FakeVenue();
  const history = opts.history ?? publish(HISTORY);
  const sourceCalls: string[] = [];
  const quotes: Record<string, VenueFundingRate[]> = { BINANCE: [], OKX: [], BYBIT: [] };
  const feeds = Object.fromEntries(Object.keys(quotes).map((v) => [v, async () => {
    sourceCalls.push(v);
    return quotes[v];
  }]));
  const listings = opts.listings === undefined ? LISTINGS : opts.listings;
  const market = createFundingMarket({
    feeds,
    now: clock.now,
    ...(listings ? { contracts: async () => {
      sourceCalls.push('contracts');
      return listings;
    } } : {}),
  });
  await market.runOnce();
  const reads = readState();
  // Books the fake read port does not know answer as the real port's failure shape.
  for (const l of listings ?? []) if (l.symbol && !reads.books[l.symbol]) reads.books[l.symbol] = { book: null, failure: { category: 'network' } };
  // Wired as production wires it: ticket 12's admission reads the same cache and mapping.
  const legOf = (symbol: string) => {
    const hit = (listings ?? []).find((l) => l.symbol === symbol);
    return hit ? { venue: hit.venue, contractId: hit.contractId } : null;
  };
  const app = makeTestApp({
    engine: { store, venue, clock },
    opportunities: { history, market },
    funding: { history, legOf, reads: fakeReads(reads, clock) },
  });
  return {
    app, store, venue, clock, history, market, sourceCalls, quotes,
    get: async (query = '') => {
      const res = await app.inject({ method: 'GET', url: `/api/funding/opportunities${query}`, headers: HOST });
      return { status: res.statusCode, body: res.json() };
    },
    post: async (url, payload) => {
      const res = await app.inject({ method: 'POST', url, headers: HOST, payload });
      return { status: res.statusCode, body: res.json() };
    },
  };
}

/** A current-period quote for the market poller to read on its next round. */
export const quote = (contractId: string, rateText: string, intervalHours = 8): VenueFundingRate => ({
  base: 'BTC', contractId, rate: Number(rateText), rateText, intervalHours, markPrice: null, nextFundingTime: null,
});
