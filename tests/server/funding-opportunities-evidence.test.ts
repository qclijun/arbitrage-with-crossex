/**
 * GET /api/funding/opportunities (ticket 18): what the page explains rather
 * than ranks — cold start, stale and behind-the-hour history kept at its
 * original time, an unwired or partial market, current-rate contrast, and
 * execution limits — and that observation reads no venue and opens nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FundingHistoryCache } from '../../src/core/funding/history-cache';
import { boardWorld, CUTOFF, id, LISTINGS, quote, type BoardWorld } from '../helpers/funding-board-fixture';
import { live } from '../helpers/funding-ranking-fixture';

let w: BoardWorld;
afterEach(async () => {
  await w?.app.close();
});

const M = 60_000;
const TOP = id('BTC', 'BINANCE BTCUSDT', 'BYBIT BTCUSDT');
const row = (body: any, rowId: string) => body.data.rows.find((r: any) => r.id === rowId);

describe('funding opportunities evidence', () => {
  it('stale history stops ranking but keeps the old evidence at its original time, and a failed refresh is named', async () => {
    w = await boardWorld();
    w.clock.t = CUTOFF + 17 * M;
    const failed = { startedAt: w.clock.t, finishedAt: w.clock.t, cutoff: CUTOFF, outcome: 'failed' as const, reason: 'round-error' as const, requests: 0, venues: {} };
    w.history.publish(null, failed);
    const res = await w.get();
    expect(res.body.data.rankedCount).toBe(0);
    const top = row(res.body, TOP);
    expect(top.rank).toBeNull();
    expect(top.windows[1]).toMatchObject({ eligible: false, coverage: 'complete', netTotal: '0.036' });
    expect(top.windows[1].reasons).toEqual(['short:history-stale', 'long:history-stale']);
    expect(top.windows[1].legs.short).toMatchObject({ fresh: false, verifiedAt: CUTOFF + M });
    expect(res.body.data.history).toMatchObject({ publishedAt: CUTOFF + M, lastRound: { outcome: 'failed' } });
  });

  it('past the next UTC hour the snapshot is behind and nothing ranks', async () => {
    w = await boardWorld();
    w.clock.t = CUTOFF + 62 * M;
    const res = await w.get();
    expect(res.body.data.history.cutoffBehind).toBe(true);
    expect(res.body.data.rankedCount).toBe(0);
    expect(row(res.body, TOP).windows[1].reasons).toContain('history-cutoff-behind');
  });

  it('a cold start keeps every candidate as UNKNOWN observation, never as zero', async () => {
    w = await boardWorld({ history: new FundingHistoryCache() });
    const res = await w.get();
    expect(res.body.data).toMatchObject({ candidateCount: 12, rankedCount: 0, snapshotId: null, history: { state: 'cold' } });
    expect(row(res.body, TOP).windows[1]).toMatchObject({ netTotal: null, coverage: 'unavailable', reasons: ['history-cold-start'] });
  });

  it('without a contract mapping the market is unwired: no candidates, no venue read', async () => {
    w = await boardWorld({ listings: null });
    const res = await w.get();
    expect(res.body.data).toMatchObject({ candidateCount: 0, rows: [], contracts: { state: 'unwired', count: 0 }, feeds: [] });
    expect(w.sourceCalls).toEqual([]);
  });

  it('names contracts it cannot pair, and lists execution limits without touching rank', async () => {
    const pepe = [
      { ...live('BINANCE', '1000PEPEUSDT', 'PEPE'), symbol: 'BINANCE_FUTURE_1000PEPE_USDT' },
      { ...live('OKX', 'PEPE-USDT-SWAP', 'PEPE'), symbol: 'OKX_FUTURE_PEPE_USDT' },
      { ...live('BYBIT', 'DOGEUSDT', 'DOGE'), underlying: null, symbol: 'BYBIT_FUTURE_DOGE_USDT' },
    ];
    w = await boardWorld({ listings: [...LISTINGS, ...pepe] });
    const res = await w.get('?limit=200');
    expect(res.body.data.contracts.unpaired).toEqual([{ venue: 'BYBIT', contractId: 'DOGEUSDT', reason: 'underlying-unverified' }]);
    expect(row(res.body, id('PEPE', 'BINANCE 1000PEPEUSDT', 'OKX PEPE-USDT-SWAP')).executionBlockers)
      .toEqual(['coin-unsupported', 'short:unit-unsupported']);
    const unmapped = row(res.body, id('BTC', 'BINANCE BTCUSDC', 'BYBIT BTCUSDT'));
    expect(unmapped).toMatchObject({ rank: 2, executionBlockers: ['short:symbol-unmapped'] });
    expect(row(res.body, TOP)).toMatchObject({ rank: 1, executionBlockers: [] });
  });

  it('contrasts current-period rates per leg and flags a reversal without re-ranking or swapping', async () => {
    w = await boardWorld();
    w.quotes.BINANCE = [quote('BTCUSDT', '0.0001')];
    w.quotes.BYBIT = [quote('BTCUSDT', '0.0002')];
    await w.market.runOnce();
    const res = await w.get();
    const top = row(res.body, TOP);
    expect(top.rank).toBe(1);
    expect(top.current).toEqual({
      short: { rate: '0.0001', intervalHours: 8, at: w.clock.t },
      long: { rate: '0.0002', intervalHours: 8, at: w.clock.t },
      netAnnualized: '-0.1095',
      reversed: true,
    });
    // OKX has no quote: no contrast, never a guessed one.
    expect(row(res.body, id('BTC', 'BINANCE BTCUSDT', 'OKX BTC-USDT-SWAP')).current).toBeNull();
  });

  it('a page request reads no source and writes nothing', async () => {
    w = await boardWorld();
    const before = [...w.sourceCalls];
    for (const query of ['', '?days=7', '?venue=OKX&offset=2&limit=3', '?days=365&positive=1']) expect((await w.get(query)).status).toBe(200);
    expect(w.sourceCalls).toEqual(before);
    expect(w.store.listPairs()).toEqual([]);
    expect(w.venue.createCalls).toEqual([]);
  });

  it('while admission is closed the page says so, and forged opens are refused server-side', async () => {
    w = await boardWorld();
    const page = await w.get();
    expect(page.body.data.admission).toMatchObject({ open: false, reason: 'never-enabled' });
    const preview = await w.post('/api/funding/preview', {
      underlying: 'BTC', snapshotId: 'snap-1', windowDays: 30,
      short: { venue: 'BINANCE', contractId: 'BTCUSDT', symbol: 'BINANCE_FUTURE_BTC_USDT' },
      long: { venue: 'BYBIT', contractId: 'BTCUSDT', symbol: 'BYBIT_FUTURE_BTC_USDT' },
      quantity: '0.01', makerLeg: 'long', leverage: { short: '3', long: '3' }, timeoutSec: 300, holdDays: '30',
    });
    expect(preview.body.data.previewId).toBeNull();
    expect(preview.body.data.blockers.map((b: any) => b.code)).toContain('admission-closed');
    const intent = await w.post('/api/funding/intents', { intentId: 'forged-1', previewId: 'p-forged', contentHash: 'x', authorizeConversion: true, acknowledgeRisks: true });
    expect(intent.status).toBe(409);
    const deal = await w.post('/api/deals', {
      id: 'forged-deal', purpose: 'funding-two-leg', qty: '0.01', execution: 'maker', price: '60000', timeoutSec: 300,
      a: { symbol: 'BYBIT_FUTURE_BTC_USDT', side: 'BUY' }, b: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL' },
    });
    expect(deal.status).toBe(409);
    expect(deal.body.error.label).toBe('funding-admission-required');
    // An old client's open (no purpose) on the same legs is refused too, before any venue read.
    const legacy = await w.post('/api/deals', {
      id: 'forged-legacy', qty: '0.01', execution: 'maker', price: '60000', timeoutSec: 300,
      a: { symbol: 'BYBIT_FUTURE_BTC_USDT', side: 'BUY' }, b: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL' },
    });
    expect(legacy.status).toBe(400);
    expect(legacy.body.error.label).toBe('client-outdated');
    expect(w.store.listPairs()).toEqual([]);
    expect(w.venue.createCalls).toEqual([]);
    expect(w.venue.leverageCalls).toEqual([]);
  });
});
