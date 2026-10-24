import { describe, expect, it } from 'vitest';
import {
  parseBinanceStyle,
  parseBybit,
  parseGate,
  parseHyperliquid,
  parseKraken,
  parseLighter,
  parseOkx,
  type VenueFundingRate,
} from '../../src/core/funding/feeds';
import { buildFundingSpreads, underlyingOf, type CrossexListing } from '../../src/core/funding/spreads';

const H = 3_600_000;

describe('funding feed parsers', () => {
  it('Binance-style: 8 h unless fundingInfo says otherwise; USDT contracts only', () => {
    const rates = parseBinanceStyle(
      [
        { symbol: 'BTCUSDT', lastFundingRate: '0.0001', markPrice: '80000', nextFundingTime: 1_000 },
        { symbol: '1000PEPEUSDT', lastFundingRate: '-0.0004', markPrice: '0.0043' },
        { symbol: 'BTCUSDC', lastFundingRate: '0.0002' },
        { symbol: 'BADUSDT', lastFundingRate: 'x' },
      ],
      [{ symbol: '1000PEPEUSDT', fundingIntervalHours: 4 }],
    );
    expect(rates).toEqual([
      { base: 'BTC', rate: 0.0001, intervalHours: 8, markPrice: 80000, nextFundingTime: 1_000 },
      { base: '1000PEPE', rate: -0.0004, intervalHours: 4, markPrice: 0.0043, nextFundingTime: null },
    ]);
  });

  it('OKX: interval is the gap from the previous settlement', () => {
    const [r] = parseOkx({
      data: [{ instId: 'ETH-USDT-SWAP', fundingRate: '0.0002', fundingTime: String(12 * H), prevFundingTime: String(8 * H) }],
    });
    expect(r).toMatchObject({ base: 'ETH', rate: 0.0002, intervalHours: 4, markPrice: null, nextFundingTime: 12 * H });
  });

  it('Bybit, Gate, Hyperliquid, Kraken, Lighter normalise to rate per interval', () => {
    expect(parseBybit({ result: { list: [{ symbol: 'SHIB1000USDT', fundingRate: '0.0001', fundingIntervalHour: '2', markPrice: '0.01' }] } }))
      .toMatchObject([{ base: 'SHIB1000', intervalHours: 2 }]);
    expect(parseGate([
      { name: 'PEPE_USDT', funding_rate: '0.0001', funding_interval: 14_400, mark_price: '0.0000043', funding_next_apply: 100 },
      { name: 'OLD_USDT', funding_rate: '0.0001', funding_interval: 28_800, in_delisting: true },
    ])).toEqual([{ base: 'PEPE', rate: 0.0001, intervalHours: 4, markPrice: 0.0000043, nextFundingTime: 100_000 }]);
    expect(parseHyperliquid([
      { universe: [{ name: 'kPEPE' }, { name: 'GONE', isDelisted: true }] },
      [{ funding: '0.0000125', markPx: '0.0043' }, { funding: '0.01', markPx: '1' }],
    ])).toEqual([{ base: 'kPEPE', rate: 0.0000125, intervalHours: 1, markPrice: 0.0043, nextFundingTime: null }]);
    expect(parseKraken({ tickers: [
      { symbol: 'PF_XBTUSD', tag: 'perpetual', relativeFundingRate: 0.00002, markPrice: 80000 },
      { symbol: 'FF_XBTUSD_260101', tag: 'month', relativeFundingRate: 1 },
    ] })).toEqual([{ base: 'BTC', rate: 0.00002, intervalHours: 1, markPrice: 80000, nextFundingTime: null }]);
    expect(parseLighter({ funding_rates: [
      { exchange: 'binance', symbol: 'BTC', rate: 0.0003 },
      { exchange: 'lighter', symbol: 'BTC', rate: 0.0001 },
    ] })).toEqual([{ base: 'BTC', rate: 0.0001, intervalHours: 8, markPrice: null, nextFundingTime: null }]);
  });
});

describe('underlyingOf', () => {
  it('strips contract multipliers but not tickers that merely start with K', () => {
    expect(underlyingOf('1000PEPE')).toEqual({ underlying: 'PEPE', multiplier: 1000 });
    expect(underlyingOf('kPEPE')).toEqual({ underlying: 'PEPE', multiplier: 1000 });
    expect(underlyingOf('SHIB1000')).toEqual({ underlying: 'SHIB', multiplier: 1000 });
    expect(underlyingOf('1MBABYDOGE')).toEqual({ underlying: 'BABYDOGE', multiplier: 1_000_000 });
    expect(underlyingOf('1000000BABYDOGE')).toEqual({ underlying: 'BABYDOGE', multiplier: 1_000_000 });
    expect(underlyingOf('KAITO')).toEqual({ underlying: 'KAITO', multiplier: 1 });
    expect(underlyingOf('1INCH')).toEqual({ underlying: '1INCH', multiplier: 1 });
  });
});

const rate = (base: string, r: number, hours: number, price: number | null): VenueFundingRate => ({
  base, rate: r, intervalHours: hours, markPrice: price, nextFundingTime: null,
});
const listing = (venue: string, base: string, quote = 'USDT'): CrossexListing => ({ venue, base, symbol: `${venue}_FUTURE_${base}_${quote}` });
const fees = (taker: string) => ['GATE', 'BINANCE', 'HYPERLIQUID', 'BYBIT'].map((v) => ({ exchangeType: v, futureMakerFee: '0', futureTakerFee: taker }));

describe('buildFundingSpreads', () => {
  it('shorts the highest APR, longs the lowest, across multiplier-named contracts', () => {
    const rows = buildFundingSpreads(
      [listing('GATE', 'PEPE'), listing('BINANCE', '1000PEPE'), listing('HYPERLIQUID', 'kPEPE', 'USDC')],
      new Map([
        ['GATE', [rate('PEPE', 0.0001, 8, 0.0000043)]],
        ['BINANCE', [rate('1000PEPE', -0.0002, 4, 0.0043)]],
        ['HYPERLIQUID', [rate('kPEPE', 0.00005, 1, 0.0043)]],
      ]),
      fees('0.0005'),
    );
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r.underlying).toBe('PEPE');
    expect(r.short.venue).toBe('HYPERLIQUID');
    expect(r.long.venue).toBe('BINANCE');
    expect(r.short.apr).toBeCloseTo(0.00005 * 8760);
    expect(r.long.apr).toBeCloseTo(-0.0002 * 2190);
    expect(r.spreadApr).toBeCloseTo(0.438 + 0.438);
    // 2 × (0.05% + 0.05%) = 0.2% of notional; daily spread 0.876/365 = 0.24%.
    expect(r.roundTripFeeRate).toBeCloseTo(0.002);
    expect(r.paybackDays).toBeCloseTo(0.002 / (0.876 / 365));
    expect(r.priceMismatch).toBe(false);
    expect(r.priceUnchecked).toBe(false);
    expect(r.unquotedVenues).toEqual([]);
  });

  it('names venues that list the coin but have no known rate', () => {
    const [r] = buildFundingSpreads(
      [listing('GATE', 'DOGE'), listing('BINANCE', 'DOGE'), listing('OKX', 'DOGE'), listing('DERIBIT', 'DOGE', 'USDC')],
      new Map([
        ['GATE', [rate('DOGE', 0.0002, 8, 0.2)]],
        ['BINANCE', [rate('DOGE', 0.0001, 8, 0.2)]],
        ['OKX', [rate('SHIB', 0.0001, 8, null)]],
      ]),
      null,
    );
    expect(r.unquotedVenues).toEqual(['DERIBIT', 'OKX']);
  });

  it('drops a venue whose price says it is another token, given three priced venues', () => {
    const [r] = buildFundingSpreads(
      [listing('GATE', 'TST'), listing('BINANCE', 'TST'), listing('BYBIT', 'TST')],
      new Map([
        ['GATE', [rate('TST', 0.01, 8, 3)]],
        ['BINANCE', [rate('TST', 0.0001, 8, 1.01)]],
        ['BYBIT', [rate('TST', -0.0001, 8, 0.99)]],
      ]),
      fees('0.0005'),
    );
    expect(r.venues.map((v) => v.venue)).toEqual(['BINANCE', 'BYBIT']);
  });

  it('flags a two-venue pair whose prices disagree, and one it cannot price', () => {
    const rows = buildFundingSpreads(
      [listing('GATE', 'A'), listing('BINANCE', 'A'), listing('GATE', 'B'), listing('HYPERLIQUID', 'B', 'USDC')],
      new Map([
        ['GATE', [rate('A', 0.001, 8, 1), rate('B', 0.001, 8, null)]],
        ['BINANCE', [rate('A', 0, 8, 2)]],
        ['HYPERLIQUID', [rate('B', 0, 1, 5)]],
      ]),
      null,
    );
    const a = rows.find((r) => r.underlying === 'A');
    const b = rows.find((r) => r.underlying === 'B');
    expect(a).toMatchObject({ priceMismatch: true, priceUnchecked: false, paybackDays: null, roundTripFeeRate: null });
    expect(b).toMatchObject({ priceMismatch: false, priceUnchecked: true });
  });

  it('skips coins quoted on one venue and listings with no feed row', () => {
    const rows = buildFundingSpreads(
      [listing('GATE', 'SOLO'), listing('GATE', 'X'), listing('BINANCE', 'X')],
      new Map([['GATE', [rate('SOLO', 0.001, 8, 1), rate('X', 0.001, 8, 1)]]]),
      null,
    );
    expect(rows).toEqual([]);
  });
});
