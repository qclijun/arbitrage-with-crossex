import { describe, expect, it } from 'vitest';
import type { VenueBookResult } from '../../src/core/estimate/books';
import type { VenueFeeRow } from '../../src/core/estimate/fees';
import { bookEvidence, feeEvidence, readCostEvidence } from '../../src/core/funding/cost-evidence';
import { estimateFundingScenario } from '../../src/core/funding/scenario';
import { AT, leg, scenario } from '../helpers/funding-cost-fixture';

const ROWS: VenueFeeRow[] = [
  { exchangeType: 'BINANCE', futureMakerFee: '0.00015', futureTakerFee: '0.0004',
    specialFeeList: [{ symbol: 'BINANCE_FUTURE_ETH_USDT', makerFeeRate: '-0.00005', takerFeeRate: '0' }] },
  { exchangeType: 'OKX', futureMakerFee: 'n/a', futureTakerFee: '0.0005' },
];
const READ = { source: 'GET /crossex/fee', at: AT };
const VIP0 = { maker: '0.0002', taker: '0.0005', at: null, basis: 'assumed' };

describe('cost evidence adapters', () => {
  it('reads the account rate with its source and read time, keeping a special zero or rebate', () => {
    expect(feeEvidence(ROWS, 'BINANCE_FUTURE_BTC_USDT', READ)).toEqual({
      status: 'known', maker: '0.00015', taker: '0.0004', source: 'GET /crossex/fee', at: AT, basis: 'real',
    });
    expect(feeEvidence(ROWS, 'binance_future_eth_usdt', READ)).toMatchObject({
      status: 'known', maker: '-0.00005', taker: '0', source: 'GET /crossex/fee special_fee_list',
    });
  });

  it('turns a missing, unreadable or malformed account rate into UNKNOWN with a VIP0 assumed reference', () => {
    expect(feeEvidence(ROWS, 'BYBIT_FUTURE_BTC_USDT', READ)).toMatchObject({ status: 'unknown', reason: 'account-rate-missing', reference: VIP0 });
    expect(feeEvidence(ROWS, 'OKX_FUTURE_BTC_USDT', READ)).toMatchObject({ status: 'unknown', reason: 'account-rate-invalid', reference: VIP0 });
    expect(feeEvidence(null, 'BINANCE_FUTURE_BTC_USDT', READ)).toMatchObject({ status: 'unknown', reason: 'read-failed', reference: VIP0 });
    // Hyperliquid's VIP0 floor matches the base ladder; the reference names its tier as an assumption.
    expect((feeEvidence(null, 'HYPERLIQUID_FUTURE_BTC_USDC', READ) as { reference: { source: string } }).reference.source).toMatch(/VIP0/);
  });

  it('keeps book levels as exact decimals stamped with the read start, and a failed read as UNKNOWN', () => {
    const ok: VenueBookResult = { book: { bids: [[99.5, 1.5e-7]], asks: [[100.25, 2]], ts: AT + 900 }, failure: null };
    expect(bookEvidence(ok, 'BINANCE', AT)).toEqual({
      status: 'known', bids: [['99.5', '0.00000015']], asks: [['100.25', '2']],
      source: 'BINANCE public order book', at: AT, basis: 'real',
    });
    const failed: VenueBookResult = { book: null, failure: { category: 'timeout', stage: 'book', httpStatus: null, errorCode: 'ERR_CANCELED', elapsedMs: 2500 } };
    expect(bookEvidence(failed, 'OKX', AT)).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  it('reads both legs fresh, stamping every item with the moment the read began', async () => {
    let clock = AT;
    const books: string[] = [];
    const evidence = await readCostEvidence({
      now: () => clock,
      listFees: async () => { clock += 400; return ROWS; },
      fetchBook: async (exchange, base, quote) => {
        books.push(`${exchange}:${base}:${quote}`);
        clock += 300;
        return exchange === 'BYBIT'
          ? { book: null, failure: { category: 'http', stage: 'book', httpStatus: 503, errorCode: null, elapsedMs: 10 } }
          : { book: { bids: [[100, 5]], asks: [[100.5, 5]], ts: clock }, failure: null };
      },
    }, { short: 'BINANCE_FUTURE_BTC_USDT', long: 'BYBIT_FUTURE_BTC_USDT' });
    expect(books.sort()).toEqual(['BINANCE:BTC:USDT', 'BYBIT:BTC:USDT']);
    expect(evidence.readAt).toBe(AT);
    expect(evidence.short.fees).toMatchObject({ status: 'known', at: AT });
    expect(evidence.short.book).toMatchObject({ status: 'known', at: AT });
    expect(evidence.long.fees).toMatchObject({ status: 'unknown', reason: 'account-rate-missing' });
    expect(evidence.long.book).toEqual({ status: 'unknown', reason: 'http' });

    const failing = await readCostEvidence({
      now: () => AT,
      listFees: async () => { throw new Error('401'); },
      fetchBook: async () => ({ book: { bids: [[100, 5]], asks: [[100.5, 5]], ts: AT }, failure: null }),
    }, { short: 'BINANCE_FUTURE_BTC_USDT', long: 'BYBIT_FUTURE_BTC_USDT' });
    expect(failing.short.fees).toMatchObject({ status: 'unknown', reason: 'read-failed' });

    // A book reader that throws costs that leg its book, not the other evidence.
    const throwing = await readCostEvidence({
      now: () => AT,
      listFees: async () => ROWS,
      fetchBook: async (exchange) => {
        if (exchange === 'BYBIT') throw new Error('boom');
        return { book: { bids: [[100, 5]], asks: [[100.5, 5]], ts: AT }, failure: null };
      },
    }, { short: 'BINANCE_FUTURE_BTC_USDT', long: 'BYBIT_FUTURE_BTC_USDT' });
    expect(throwing.long.book).toEqual({ status: 'unknown', reason: 'unexpected' });
    expect(throwing.short).toMatchObject({ fees: { status: 'known' }, book: { status: 'known' } });

    // Wired into a scenario, the failed book blocks it instead of reading as free.
    const s = estimateFundingScenario(scenario({
      short: leg('BINANCE_FUTURE_BTC_USDT', '0.03', '110', { fees: evidence.short.fees, book: evidence.short.book }),
      long: leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100', { fees: evidence.long.fees, book: evidence.long.book }),
    }));
    expect(s.unknown).toEqual(expect.arrayContaining(['long:book-http', 'long:fee-account-rate-missing']));
    expect(s.normal.payback.kind).toBe('unknown');
  });
});
