/**
 * POST /api/funding/preview (ticket 12): one fresh read-only evidence round,
 * judged into the exact content a user would confirm. Any UNKNOWN, failed
 * read or failing gate is a named blocker — the preview stays observable but
 * carries no acceptable id — and nothing is written or sent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { deal, order } from '../helpers/slice-fixture';
import { fundingWorld, LONG_SYMBOL, SHORT_SYMBOL, USDT_LONG, type FundingWorld } from '../helpers/funding-intent-fixture';

let w: FundingWorld;
afterEach(async () => {
  await w?.app.close();
});

const codes = (res: { body: any }) => res.body.data.blockers.map((b: { code: string }) => b.code);

describe('funding preview', () => {
  it('binds the exact candidate and final parameters, valid 10 s from its read, with no side effects', async () => {
    w = fundingWorld();
    const res = await w.preview();
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.blockers).toEqual([]);
    expect(data.previewId).toEqual(expect.any(String));
    expect(data.expiresAt).toBe(data.readAt + 10_000);
    expect(data.content).toMatchObject({
      candidateId: JSON.stringify(['ETH', 'OKX', 'ETH-USDT-SWAP', 'HYPERLIQUID', 'ETH']),
      quantityInput: '0.1505', quantity: '0.15', rounding: expect.stringContaining('0.001'),
      makerPrice: '2499.9', timeoutSec: 300, onExpiry: 'convert-to-taker', currency: 'USDT',
      legs: { long: { role: 'maker', side: 'BUY', leverage: '5' }, short: { role: 'hedge', side: 'SELL', leverage: '3' } },
      fees: { short: { maker: '0.0002', taker: '0.0005' }, long: { maker: '0.0001', taker: '0.00045' } },
      fx: 'known:USDC/USDT', borrow: 'not-applicable',
    });
    expect(data.content.warnings).toEqual(expect.arrayContaining(['maker-expiry-converts-remainder-to-taker', `leverage-change:${LONG_SYMBOL}:10->5`]));
    expect(data.content.amounts.normalOneTime).toMatch(/^-?\d+(\.\d{1,2})?$/);
    expect(w.venue.leverageCalls).toEqual([]);
    expect(w.venue.createCalls).toEqual([]);
    expect(w.store.listPairs()).toEqual([]);
  });

  it.each([
    ['fees', 'fees-unknown'],
    ['account', 'margin-unknown'],
    ['positions', 'positions-unknown'],
    ['openOrders', 'open-orders-unknown'],
    ['leverage', 'leverage-unread'],
    ['leverageMax', 'leverage-unknown'],
    ['rules', 'rules-unknown'],
    ['spot', 'fx-unknown'],
  ])('a failed %s read blocks (%s) — never a pass', async (read, code) => {
    w = fundingWorld();
    w.state.fail.add(read);
    const res = await w.preview();
    expect(codes(res)).toContain(code);
    expect(res.body.data.previewId).toBeNull();
  });

  it('blocks a NaN fee rate, a thin book and a missing book as UNKNOWN, with the assumed tier never standing in', async () => {
    w = fundingWorld();
    w.state.fees[0].futureTakerFee = 'NaN';
    expect(codes(await w.preview())).toContain('fees-unknown');

    w.state.fees[0].futureTakerFee = '0.00045';
    w.state.books[SHORT_SYMBOL] = { book: { bids: [[2501.9, 0.01]], asks: [[2502.1, 0.01]], ts: 0 }, failure: null };
    const thin = await w.preview();
    expect(thin.body.data.blockers).toContainEqual({ code: 'scenario-unknown', message: expect.stringMatching(/depth-insufficient/) });

    w.state.books[SHORT_SYMBOL] = { book: null, failure: { category: 'timeout' } };
    expect(codes(await w.preview())).toContain('scenario-unknown');
  });

  it('blocks insufficient margin, leverage above the venue maximum and a closed admission switch', async () => {
    w = fundingWorld();
    w.state.account.availableMargin = '100';
    expect(codes(await w.preview())).toContain('margin-insufficient');
    w.state.account.availableMargin = '10000';
    expect(codes(await w.preview({ leverage: { short: '25', long: '5' } }))).toContain('leverage-above-maximum');
    w.store.admission.disable(w.clock.now());
    expect(codes(await w.preview())).toContain('admission-closed');
  });

  it('blocks history that is not admissible and a symbol not proven to be the ranked contract', async () => {
    w = fundingWorld();
    w.history.opts.admitted = false;
    expect(codes(await w.preview())).toContain('history-ineligible');
    w.history.opts.admitted = true;
    expect(codes(await w.preview({ long: { venue: 'HYPERLIQUID', contractId: 'BTC', symbol: LONG_SYMBOL } }))).toContain('symbol-unmapped');
  });

  it('blocks an opposite position, an unattributed same-side one, an open order and an active deal', async () => {
    w = fundingWorld();
    w.state.positions = [{ symbol: LONG_SYMBOL, positionQty: '-0.2' }];
    expect(codes(await w.preview())).toContain('opposite-position');
    w.state.positions = [{ symbol: LONG_SYMBOL, positionQty: '0.2' }];
    expect(codes(await w.preview())).toContain('unattributed-position');
    w.state.positions = [];
    w.state.openOrders = [{ symbol: SHORT_SYMBOL }];
    expect(codes(await w.preview())).toContain('open-order');
    w.state.openOrders = [];
    deal(w.store, 'busy-deal', { contract: SHORT_SYMBOL, side: 'SELL' }, null, '0.1');
    expect(codes(await w.preview())).toContain('active-deal');
  });

  it('shares a same-side position only when every unit of it is a reconciled slice', async () => {
    w = fundingWorld();
    w.store.slices.create({
      id: 'old', kind: 'funding-two-leg', source: {}, now: 1, observed: { [LONG_SYMBOL]: '0', [SHORT_SYMBOL]: '0' },
      legs: [{ leg: 'long', contract: LONG_SYMBOL, side: 'long' }, { leg: 'short', contract: SHORT_SYMBOL, side: 'short' }],
    });
    deal(w.store, 'old-open', { contract: LONG_SYMBOL, side: 'BUY' }, { contract: SHORT_SYMBOL, side: 'SELL' }, '0.2', { mode: 'DONE' });
    w.store.slices.attach('old-open', 'old', 'open');
    order(w.store, 'old-open', 'A', '0.2', '0.2');
    order(w.store, 'old-open', 'B', '0.2', '0.2');
    w.store.slices.bookFills('old-open', 200);
    w.state.positions = [{ symbol: LONG_SYMBOL, positionQty: '0.2' }, { symbol: SHORT_SYMBOL, positionQty: '-0.2' }];
    expect(codes(await w.preview())).toEqual([]);

    w.state.positions = [{ symbol: LONG_SYMBOL, positionQty: '0.25' }, { symbol: SHORT_SYMBOL, positionQty: '-0.2' }];
    expect(codes(await w.preview())).toContain('contract-unreconciled');
  });

  it('needs no FX for a same-quote pair, and a USDC/USDT one only from a current, timed book', async () => {
    w = fundingWorld();
    w.state.fail.add('spot');
    const same = await w.preview({ long: { venue: 'BINANCE', contractId: 'ETHUSDT', symbol: USDT_LONG } });
    expect(same.body.data.content.fx).toBe('none');
    expect(same.body.data.blockers.map((b: { code: string }) => b.code)).not.toContain('fx-unknown');

    w.state.fail.delete('spot');
    w.state.spotAt = w.clock.now() - 10_001;
    expect(codes(await w.preview())).toContain('fx-unknown');
    w.state.spotAt = null;
    expect(codes(await w.preview())).toContain('fx-unknown');
  });

  it('charges an existing liability as known carry, and blocks one it cannot price', async () => {
    w = fundingWorld();
    w.state.account.assets = [{ coin: 'USDT', liability: '1000', exchangeType: 'CROSSEX' }, { coin: 'USDC', liability: '0' }];
    w.state.interest = [{ coin: 'USDT', exchangeType: 'CROSSEX', hourInterestRate: '0.00001', time: '0' }];
    const res = await w.preview();
    expect(res.body.data.content.borrow).toBe('known:USDT');
    expect(res.body.data.scenario.carry).toMatchObject({ item: 'borrow', rate: '0.00024', amount: { status: 'known', value: '0.24' } });
    w.state.interest = [];
    expect(codes(await w.preview())).toContain('borrow-unknown');
  });

  it.each([
    [{ timeoutSec: 29 }], [{ timeoutSec: 3601 }], [{ timeoutSec: 300.5 }], [{ makerLeg: undefined }],
    [{ leverage: { short: '3' } }], [{ quantity: '0' }], [{ quantity: '1e-3' }], [{ windowDays: 14 }],
  ])('refuses an invalid request without reading anything: %j', async (over) => {
    w = fundingWorld();
    const res = await w.preview(over);
    expect(res.status).toBe(400);
    expect(w.reads.calls).toBe(0);
  });

  it('refuses when the install has no funding history, instead of falling back to a plain pair', async () => {
    w = fundingWorld({ funding: false });
    expect((await w.preview()).status).toBe(503);
  });
});
