/**
 * Offline world for the funding preview/acceptance routes (ticket 12): a
 * scriptable read port, a history port bound to the virtual clock's UTC hour,
 * the fake venue and an admission switch already enabled. Nothing here is a
 * recorded venue read; real HTTP stays blocked.
 */
import type { FastifyInstance } from 'fastify';
import type { HistoryAdmission } from '../../src/core/funding/history-cache';
import { snapshotCutoff, type FundingHistoryResult } from '../../src/core/funding/history';
import { Store } from '../../src/engine/db';
import { tickPair } from '../../src/engine/loop';
import type { FundingReads } from '../../src/server/funding/reads';
import { A_CONTRACT, B_CONTRACT, FakeVenue, VirtualClock } from '../unit/engine-sim';
import { HOST, makeTestApp } from '../server/helpers/gate-nock';

export { A_CONTRACT as LONG_SYMBOL, B_CONTRACT as SHORT_SYMBOL };

const top = (bid: number, ask: number, size = 10) => ({ book: { bids: [[bid, size]] as Array<[number, number]>, asks: [[ask, size]] as Array<[number, number]>, ts: 0 }, failure: null });

/** Mutable venue-side reality the read port serves; `fail` makes a read throw. */
export function readState() {
  return {
    rules: [A_CONTRACT, B_CONTRACT].map((symbol) => ({ symbol, state: 'live', businessType: 'FUTURE', lotSize: '0.001', minSize: '0.001', minNotional: '5', tickSize: '0.01', maxMarketSize: '100', maxLimitSize: '100' })),
    leverageMax: new Map([[A_CONTRACT, 50], [B_CONTRACT, 20]]),
    leverage: { [A_CONTRACT]: '10', [B_CONTRACT]: '3' } as Record<string, unknown>,
    fees: [
      { exchangeType: 'HYPERLIQUID', futureMakerFee: '0.0001', futureTakerFee: '0.00045' },
      { exchangeType: 'OKX', futureMakerFee: '0.0002', futureTakerFee: '0.0005' },
    ],
    books: { [A_CONTRACT]: top(2499.9, 2500.1), [B_CONTRACT]: top(2501.9, 2502.1) } as Record<string, ReturnType<typeof top> | { book: null; failure: { category: string } }>,
    account: { availableMargin: '10000', positionMode: 'SINGLE', assets: [{ coin: 'USDT', liability: '0' }, { coin: 'USDC', liability: '0' }] } as Record<string, unknown>,
    interest: [] as unknown[],
    positions: [] as Array<{ symbol: string; positionQty: string }>,
    openOrders: [] as Array<{ symbol: string }>,
    spot: { bid: '0.9998', ask: '1.0002' },
    fail: new Set<string>(),
    /** Virtual ms each read round takes (advanced on the clock before it answers). */
    readMs: 0,
  };
}

export type ReadState = ReturnType<typeof readState>;

export function fakeReads(s: ReadState, clock: VirtualClock): FundingReads & { calls: number } {
  const r = <T>(name: string, value: () => T) => async (): Promise<T> => {
    if (name === 'account') {
      port.calls += 1;
      clock.advance(s.readMs);
    }
    if (s.fail.has(name)) throw new Error(`${name} read failed`);
    return value();
  };
  const port = {
    calls: 0,
    rules: r('rules', () => s.rules as never),
    leverageMax: r('leverageMax', () => s.leverageMax),
    leverage: r('leverage', () => s.leverage),
    fees: r('fees', () => s.fees),
    book: async (exchange: string, base: string, quote: string) => s.books[`${exchange}_FUTURE_${base}_${quote}`] as never,
    account: r('account', () => s.account as never),
    interestRates: r('interest', () => s.interest as never),
    positions: r('positions', () => s.positions),
    openOrders: r('openOrders', () => s.openOrders),
    spotTop: async () => {
      if (s.fail.has('spot')) throw new Error('spot read failed');
      return s.spot;
    },
  };
  return port;
}

/** History admitted only while the clock stays in the hour it was published for. */
export function historyPort(clock: VirtualClock, opts: { admitted: boolean } = { admitted: true }) {
  const cutoff = snapshotCutoff(clock.now());
  return {
    opts,
    recheck: (req: { snapshotId: string }, now: number): HistoryAdmission => {
      if (!opts.admitted) return { admitted: false, reason: 'history-ineligible' };
      if (req.snapshotId !== 'snap-1') return { admitted: false, reason: 'history-snapshot-superseded' };
      if (snapshotCutoff(now) !== cutoff) return { admitted: false, reason: 'history-cutoff-behind' };
      return { admitted: true, result: { cutoff, short: { total: '0.009' }, long: { total: '0.0015' } } as unknown as FundingHistoryResult };
    },
  };
}

export const LEGS: Record<string, { venue: string; contractId: string }> = {
  [A_CONTRACT]: { venue: 'HYPERLIQUID', contractId: 'ETH' },
  [B_CONTRACT]: { venue: 'OKX', contractId: 'ETH-USDT-SWAP' },
};

export function request(over: Record<string, unknown> = {}) {
  return {
    underlying: 'ETH', snapshotId: 'snap-1', windowDays: 30,
    short: { ...LEGS[B_CONTRACT], symbol: B_CONTRACT }, long: { ...LEGS[A_CONTRACT], symbol: A_CONTRACT },
    quantity: '0.1505', makerLeg: 'long', leverage: { short: '3', long: '5' }, timeoutSec: 300, holdDays: '30',
    ...over,
  };
}

export interface FundingWorld {
  app: FastifyInstance; store: Store; venue: FakeVenue; clock: VirtualClock; reads: ReturnType<typeof fakeReads>;
  state: ReadState; history: ReturnType<typeof historyPort>;
  preview(over?: Record<string, unknown>): Promise<{ status: number; body: any }>;
  accept(body: Record<string, unknown>): Promise<{ status: number; body: any }>;
  receipt(id: string): Promise<{ status: number; body: any }>;
  tick(dealId: string, n?: number): Promise<void>;
}

export function fundingWorld(opts: { at?: number; funding?: boolean } = {}): FundingWorld {
  const store = new Store(':memory:', { programVersion: '9.9.9' });
  const venue = new FakeVenue();
  const clock = new VirtualClock();
  if (opts.at !== undefined) clock.t = opts.at;
  store.admission.enable(clock.now());
  const state = readState();
  const reads = fakeReads(state, clock);
  const history = historyPort(clock);
  const app = makeTestApp({
    engine: { store, venue, clock },
    ...(opts.funding === false ? {} : { funding: { history, legOf: (s: string) => LEGS[s] ?? null, reads } }),
  });
  const send = async (method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url, headers: HOST, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.json() };
  };
  return {
    app, store, venue, clock, reads, state, history,
    preview: (over) => send('POST', '/api/funding/preview', request(over)),
    accept: (body) => send('POST', '/api/funding/intents', body),
    receipt: (id) => send('GET', `/api/funding/intents/${id}`),
    tick: async (dealId, n = 1) => {
      for (let i = 0; i < n; i++) {
        await tickPair({ store, venue, clock }, dealId);
        clock.advance(1000);
      }
    },
  };
}

/** The acceptance body for a preview response, confirmed as shown. */
export const confirm = (preview: any, intentId = 'intent-001', over: Record<string, unknown> = {}) => ({
  intentId, previewId: preview.body.data.previewId, contentHash: preview.body.data.contentHash, authorizeConversion: true, acknowledgeRisks: true, ...over,
});
