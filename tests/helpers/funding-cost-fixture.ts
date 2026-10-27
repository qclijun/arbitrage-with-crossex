/** Synthetic, offline cost evidence for funding scenario tests: nothing here is a recorded venue read. */
import type { BookEvidence, FeeEvidence, ScenarioInput, ScenarioLeg } from '../../src/core/funding/scenario';

export const AT = Date.UTC(2026, 9, 1, 0, 2);

/** A one-level book: `bid` and `ask` (zero spread by default), each `size` deep. */
export function book(bid: string, ask = bid, size = '1000'): Extract<BookEvidence, { status: 'known' }> {
  return { status: 'known', bids: [[bid, size]], asks: [[ask, size]], source: 'synthetic book', at: AT, basis: 'real' };
}

export function fees(maker: string, taker: string): FeeEvidence {
  return { status: 'known', maker, taker, source: 'synthetic /crossex/fee', at: AT, basis: 'real' };
}

export function leg(symbol: string, fundingTotal: string | null, price: string, over: Partial<ScenarioLeg> = {}): ScenarioLeg {
  return { symbol, fundingTotal, fees: fees('0', '0'), book: book(price), ...over };
}

/** Short and long both quote USDT; no borrow or conversion applies, with the reason stated. */
export function scenario(over: Partial<ScenarioInput> = {}): ScenarioInput {
  return {
    quantity: '1',
    holdDays: '3',
    currency: 'USDT',
    windowDays: 30,
    makerLeg: 'short',
    short: leg('BINANCE_FUTURE_BTC_USDT', '0.03', '110'),
    long: leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100'),
    fx: [],
    borrow: { status: 'not-applicable', evidence: 'synthetic: fully collateralized in USDT', source: 'synthetic account', at: AT, basis: 'real' },
    conversion: { status: 'not-applicable', evidence: 'synthetic: both legs settle in USDT', source: 'synthetic account', at: AT, basis: 'real' },
    ...over,
  };
}
