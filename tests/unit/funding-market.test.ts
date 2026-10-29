/**
 * The funding market poller (ticket 18): the proven contract list and each
 * listed venue's current-period quotes, read in the background into memory so
 * the opportunities page never reaches a venue. A failed read keeps the last
 * evidence with its original time; nothing is re-stamped.
 */
import { describe, expect, it } from 'vitest';
import type { VenueFundingRate } from '../../src/core/funding/feeds';
import { legKey } from '../../src/core/funding/history-cache';
import { createFundingMarket, type FundingContractListing } from '../../src/core/funding/market';

const listing = (venue: string, contractId: string, symbol: string | null = null): FundingContractListing => ({
  venue, contractId, symbol,
  underlying: { id: 'BTC', evidence: 'proof' },
  rateBasis: { id: 'per-settlement', evidence: 'proof' },
});

const quote = (contractId: string, rateText: string, intervalHours = 8): VenueFundingRate => ({
  base: 'BTC', contractId, rate: Number(rateText), rateText, intervalHours, markPrice: null, nextFundingTime: null,
});

function world() {
  let now = 1_000_000;
  const calls: string[] = [];
  const fail = new Set<string>();
  const feed = (venue: string, rows: () => VenueFundingRate[]) => async () => {
    calls.push(venue);
    if (fail.has(venue)) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return rows();
  };
  let listings = [listing('BINANCE', 'BTCUSDT', 'BINANCE_FUTURE_BTC_USDT'), listing('OKX', 'BTC-USDT-SWAP')];
  const rates = { BINANCE: '0.0001', OKX: '-0.0002' };
  const feeds = {
    BINANCE: feed('BINANCE', () => [quote('BTCUSDT', rates.BINANCE), quote('ETHUSDT', '0.0003')]),
    OKX: feed('OKX', () => [quote('BTC-USDT-SWAP', rates.OKX, 4)]),
    BYBIT: feed('BYBIT', () => [quote('BTCUSDT', '0.0009')]),
  };
  const contracts = async () => {
    calls.push('contracts');
    if (fail.has('contracts')) throw new Error('mapping down');
    return listings;
  };
  return {
    calls, fail, rates, feeds, contracts,
    setListings: (next: FundingContractListing[]) => { listings = next; },
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe('funding market poller', () => {
  it('without a contract mapping it is unwired and reads no venue at all', async () => {
    const w = world();
    const market = createFundingMarket({ feeds: w.feeds, now: w.now });
    await market.runOnce();
    expect(market.view().contracts).toEqual({ state: 'unwired' });
    expect(market.view().current.size).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it('reads only the venues the listed contracts trade, keyed by venue-native contract', async () => {
    const w = world();
    const market = createFundingMarket({ contracts: w.contracts, feeds: w.feeds, now: w.now });
    expect(market.view().contracts).toMatchObject({ state: 'cold' });
    await market.runOnce();
    expect(w.calls.sort()).toEqual(['BINANCE', 'OKX', 'contracts']);
    const view = market.view();
    expect(view.contracts).toMatchObject({ state: 'ready', at: 1_000_000, listings: expect.any(Array) });
    expect(view.current.get(legKey({ venue: 'BINANCE', contractId: 'BTCUSDT' }))).toEqual({ rate: '0.0001', intervalHours: 8, at: 1_000_000 });
    expect(view.current.get(legKey({ venue: 'OKX', contractId: 'BTC-USDT-SWAP' }))).toEqual({ rate: '-0.0002', intervalHours: 4, at: 1_000_000 });
    expect(view.feeds).toEqual([
      { venue: 'BINANCE', ok: true, at: 1_000_000, count: 2, error: null },
      { venue: 'OKX', ok: true, at: 1_000_000, count: 1, error: null },
    ]);
  });

  it('a failed read keeps the last quotes and listings at their original time and names the failure', async () => {
    const w = world();
    const market = createFundingMarket({ contracts: w.contracts, feeds: w.feeds, now: w.now });
    await market.runOnce();
    w.advance(60_000);
    w.rates.BINANCE = '0.0005';
    w.rates.OKX = '0.0007';
    w.fail.add('OKX');
    w.fail.add('contracts');
    await market.runOnce();
    const view = market.view();
    expect(view.contracts).toMatchObject({ state: 'ready', at: 1_000_000, lastAttempt: { at: 1_060_000, ok: false } });
    expect(view.current.get(legKey({ venue: 'BINANCE', contractId: 'BTCUSDT' }))).toEqual({ rate: '0.0005', intervalHours: 8, at: 1_060_000 });
    expect(view.current.get(legKey({ venue: 'OKX', contractId: 'BTC-USDT-SWAP' }))).toEqual({ rate: '-0.0002', intervalHours: 4, at: 1_000_000 });
    expect(view.feeds.find((f) => f.venue === 'OKX')).toEqual({ venue: 'OKX', ok: false, at: 1_000_000, count: 1, error: 'network' });
  });

  it('a venue with no feed is named, and a venue no longer listed is dropped', async () => {
    const w = world();
    const market = createFundingMarket({ contracts: w.contracts, feeds: w.feeds, now: w.now });
    await market.runOnce();
    w.setListings([listing('BINANCE', 'BTCUSDT'), listing('DERIBIT', 'BTC-PERPETUAL')]);
    await market.runOnce();
    const view = market.view();
    expect(view.feeds).toEqual([
      { venue: 'BINANCE', ok: true, at: 1_000_000, count: 2, error: null },
      { venue: 'DERIBIT', ok: false, at: null, count: 0, error: 'no-feed' },
    ]);
    expect(view.current.has(legKey({ venue: 'OKX', contractId: 'BTC-USDT-SWAP' }))).toBe(false);
  });
});
