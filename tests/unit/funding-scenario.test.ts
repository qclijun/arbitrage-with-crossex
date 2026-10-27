import { describe, expect, it } from 'vitest';
import { estimateFundingScenario } from '../../src/core/funding/scenario';
import { enumerateFundingCandidates, rankFundingCandidates } from '../../src/core/funding/ranking';
import { AT, book, fees, leg, scenario } from '../helpers/funding-cost-fixture';
import { NOW, flat, historyLeg, live, publish } from '../helpers/funding-ranking-fixture';

describe('funding holding-period scenario', () => {
  it('prices each leg at its own notional for the same underlying quantity', () => {
    // N_short=110, N_long=100, 0.001/day against 0.0005/day: 0.06, never 100 × 0.0005 = 0.05.
    const s = estimateFundingScenario(scenario());
    expect(s.legs.short.notional).toEqual({ status: 'known', value: '110' });
    expect(s.legs.long.notional).toEqual({ status: 'known', value: '100' });
    expect(s.grossDaily).toEqual({ status: 'known', value: '0.06' });
    expect(s.daily).toEqual({ status: 'known', value: '0.06' });
    // Hedge open and both closes each cross half the spread; the resting maker earns no credit.
    expect(s.normal.oneTime).toEqual({ status: 'known', value: '1.5' });
    expect(s.normal.holdResult).toEqual({ status: 'known', value: '-1.32' });
    expect(s.normal.payback).toEqual({ kind: 'days', days: '25' });
  });

  it('pays back C over D, and shows a holding period too short to pay back as a loss', () => {
    // G = 100 × 0.6 / 30 = 2; C = hedge fees 3.015 + 2.985, book 1.5, a required conversion 2.5.
    const s = estimateFundingScenario(scenario({
      short: leg('BINANCE_FUTURE_BTC_USDT', '0.6', '100'),
      long: leg('BYBIT_FUTURE_BTC_USDT', '0', '100', { fees: fees('0', '0.03') }),
      conversion: { status: 'known', currency: 'USDT', amount: '2.5', source: 'synthetic swap quote', at: AT, basis: 'real' },
    }));
    expect(s.daily).toEqual({ status: 'known', value: '2' });
    expect(s.normal.oneTime).toEqual({ status: 'known', value: '10' });
    expect(s.normal.payback).toEqual({ kind: 'days', days: '5' });
    expect(s.normal.holdResult).toEqual({ status: 'known', value: '-4' });
    const fills = s.normal.lines.filter((l) => l.item === 'fee').map((l) => [l.leg, l.phase, l.role, l.amount]);
    expect(fills).toEqual([
      ['short', 'open', 'maker', { status: 'known', value: '0' }],
      ['long', 'open', 'taker', { status: 'known', value: '3.015' }],
      ['short', 'close', 'taker', { status: 'known', value: '0' }],
      ['long', 'close', 'taker', { status: 'known', value: '2.985' }],
    ]);
    // An unfilled maker A converted to taker, on the whole quantity: a reference, not a cap.
    expect(s.conversion.fullQuantity).toBe(true);
    expect(s.conversion.oneTime).toEqual({ status: 'known', value: '10.5' });
    expect(s.conversion.payback).toEqual({ kind: 'days', days: '5.25' });
    expect(s.unknown).toEqual([]);
  });

  it('keeps real fees UNKNOWN when the account rate is missing, showing VIP0 only as a labeled assumption', () => {
    const vip0 = { maker: '0.0002', taker: '0.0005', source: 'VIP0 schedule', at: null, basis: 'assumed' as const };
    const s = estimateFundingScenario(scenario({
      long: leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100', { fees: { status: 'unknown', reason: 'account-rate-missing', reference: vip0 } }),
    }));
    expect(s.normal.oneTime).toEqual({ status: 'unknown', reasons: ['long:fee-account-rate-missing'] });
    expect(s.normal.payback).toEqual({ kind: 'unknown', reasons: ['long:fee-account-rate-missing'] });
    expect(s.conversion.payback.kind).toBe('unknown');
    expect(s.unknown).toEqual(['long:fee-account-rate-missing']);
    // Long taker fees 0.05025 + 0.04975 at VIP0 over book 1.5; the short leg stays on its real zero rates.
    expect(s.assumedReference!.normal.oneTime).toEqual({ status: 'known', value: '1.6' });
    expect(s.assumedReference!.normal.lines.find((l) => l.leg === 'long' && l.item === 'fee')!.basis).toBe('assumed');
    expect(s.assumedReference!.normal.lines.find((l) => l.leg === 'short' && l.item === 'fee')!.basis).toBe('real');

    const bare = estimateFundingScenario(scenario({
      long: leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100', { fees: { status: 'unknown', reason: 'read-failed', reference: null } }),
    }));
    expect(bare.assumedReference).toBeNull();
  });

  it('keeps a known zero rate and a maker rebate as known amounts, not as unknown', () => {
    const s = estimateFundingScenario(scenario({
      short: leg('BINANCE_FUTURE_BTC_USDT', '0.03', '110', { fees: fees('-0.02', '0') }),
    }));
    const fee = (phase: string) => s.normal.lines.find((l) => l.leg === 'short' && l.item === 'fee' && l.phase === phase)!;
    // Resting at the 110.5 ask: a 2.21 rebate.
    expect(fee('open')).toMatchObject({ role: 'maker', rate: '-0.02', amount: { status: 'known', value: '-2.21' }, basis: 'real' });
    expect(fee('close')).toMatchObject({ role: 'taker', rate: '0', amount: { status: 'known', value: '0' } });
    expect(s.normal.oneTime).toEqual({ status: 'known', value: '-0.71' });
    expect(s.normal.payback).toEqual({ kind: 'not-needed' });
  });

  it('walks the whole quantity through the book once, and never extrapolates a thin book', () => {
    // Hedge B (long) buys 2 across 100 and 102 against a 99/100 mid of 99.5: 1.5 a unit over mid.
    const deep = estimateFundingScenario(scenario({
      quantity: '2',
      long: leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100', { book: { ...book('99', '100', '1'), asks: [['100', '1'], ['102', '1']] } }),
    }));
    const impact = deep.normal.lines.find((l) => l.leg === 'long' && l.phase === 'open' && l.item === 'book')!;
    expect(impact).toMatchObject({ price: '101', rate: null, amount: { status: 'known', value: '3' }, source: 'synthetic book', at: AT });
    // The fee is charged on the walked price; there is no second slippage line for the same fill.
    expect(deep.normal.lines.filter((l) => l.leg === 'long' && l.phase === 'open')).toHaveLength(2);

    const thin = estimateFundingScenario(scenario({
      quantity: '3',
      long: leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100', { book: book('100', '100', '2') }),
    }));
    expect(thin.normal.oneTime).toEqual({ status: 'unknown', reasons: ['long:open:depth-insufficient', 'long:close:depth-insufficient'] });
    expect(thin.daily).toEqual({ status: 'known', value: '0.18' });
    expect(thin.unknown).toContain('long:open:depth-insufficient');
  });

  it('takes no credit for an unfilled maker inside the mid, charges one priced past it, and refuses one that crosses', () => {
    const long = leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100', { book: book('99', '101') });
    const open = (makerPrice?: string) => estimateFundingScenario(scenario({ makerLeg: 'long', makerPrice, long }))
      .normal.lines.find((l) => l.leg === 'long' && l.phase === 'open' && l.item === 'book')!;
    expect(open()).toMatchObject({ role: 'maker', price: '99', amount: { status: 'known', value: '0' } });
    expect(open('100.5')).toMatchObject({ price: '100.5', amount: { status: 'known', value: '0.5' } });
    // A post-only buy at or above the ask would not rest; it is no maker evidence at all.
    expect(open('101')).toMatchObject({ price: null, amount: { status: 'unknown', reasons: ['long:open:maker-price-crosses-book'] } });
  });

  it('converts a USDC leg only with an explicit rate, never assuming stablecoins trade 1:1', () => {
    const long = leg('HYPERLIQUID_FUTURE_BTC_USDC', '0.015', '100');
    const missing = estimateFundingScenario(scenario({ long }));
    expect(missing.legs.long.notional).toEqual({ status: 'unknown', reasons: ['long:fx-missing:USDC/USDT'] });
    expect(missing.grossDaily.status).toBe('unknown');
    expect(missing.normal.payback).toEqual({ kind: 'unknown', reasons: ['long:fx-missing:USDC/USDT'] });
    expect(missing.legs.short.notional).toEqual({ status: 'known', value: '110' });

    const rate = { from: 'USDC', to: 'USDT', rate: '0.9995', source: 'synthetic USDC/USDT', at: AT, basis: 'real' as const };
    const s = estimateFundingScenario(scenario({ long, fx: [rate] }));
    expect(s.legs.long.fx).toMatchObject({ status: 'known', rate: '0.9995', source: 'synthetic USDC/USDT' });
    expect(s.legs.long.notional).toEqual({ status: 'known', value: '99.95' });
    // 110 × 0.001 − 99.95 × 0.0005
    expect(s.grossDaily).toEqual({ status: 'known', value: '0.060025' });
    // Two quotes for the same conversion that disagree prove neither.
    const split = estimateFundingScenario(scenario({ long, fx: [rate, { ...rate, rate: '1.0002' }] }));
    expect(split.legs.long.notional).toEqual({ status: 'unknown', reasons: ['long:fx-unverified:USDC/USDT'] });
  });

  it('lets a daily carry cost eat a positive funding spread, and never fills an unknown carry with zero', () => {
    const borrow = { status: 'known' as const, currency: 'USDT', principal: '1000', dailyRate: '0.0001', source: 'synthetic borrow rate', at: AT, basis: 'real' as const };
    const s = estimateFundingScenario(scenario({ borrow }));
    expect(s.grossDaily).toEqual({ status: 'known', value: '0.06' });
    expect(s.carry).toMatchObject({ item: 'borrow', nature: 'daily', rate: '0.0001', amount: { status: 'known', value: '0.1' } });
    expect(s.daily).toEqual({ status: 'known', value: '-0.04' });
    // C ≤ 0 but D ≤ 0: no finite payback, never a negative day count.
    expect(s.normal.payback).toEqual({ kind: 'none' });
    expect(s.normal.holdResult).toEqual({ status: 'known', value: '-1.62' });

    const unknown = estimateFundingScenario(scenario({ borrow: { status: 'unknown', reason: 'not-queried' } }));
    expect(unknown.daily).toEqual({ status: 'unknown', reasons: ['borrow-not-queried'] });
    expect(unknown.normal.payback).toEqual({ kind: 'unknown', reasons: ['borrow-not-queried'] });
    // "Not applicable" holds only with stated evidence.
    const unproven = estimateFundingScenario(scenario({ borrow: { status: 'not-applicable', evidence: '', source: 'x', at: AT, basis: 'real' } }));
    expect(unproven.unknown).toEqual(['borrow-not-applicable-unproven']);
    expect(estimateFundingScenario(scenario()).carry).toMatchObject({ amount: { status: 'known', value: '0' }, notApplicable: 'synthetic: fully collateralized in USDT' });
  });

  it('counts a required currency conversion once, as a one-time cost in the common currency', () => {
    const conversion = { status: 'known' as const, currency: 'USDC', amount: '2', source: 'synthetic swap quote', at: AT, basis: 'real' as const };
    const fx = [{ from: 'USDC', to: 'USDT', rate: '0.9995', source: 'synthetic USDC/USDT', at: AT, basis: 'real' as const }];
    const s = estimateFundingScenario(scenario({ conversion, fx }));
    expect(s.normal.lines.filter((l) => l.item === 'conversion')).toMatchObject([{ nature: 'one-time', amount: { status: 'known', value: '1.999' } }]);
    expect(s.normal.oneTime).toEqual({ status: 'known', value: '3.499' });
    expect(s.conversion.oneTime).toEqual({ status: 'known', value: '3.999' });
    expect(estimateFundingScenario(scenario({ conversion })).unknown).toEqual(['conversion:fx-missing:USDC/USDT']);
  });

  it('applies signs as they are: both legs negative can still pay, and a zero or negative D has no payback', () => {
    // short −0.001/day, long −0.003/day on 100 each: short pays 0.1, long receives 0.3.
    const both = estimateFundingScenario(scenario({
      short: leg('BINANCE_FUTURE_BTC_USDT', '-0.03', '100'),
      long: leg('BYBIT_FUTURE_BTC_USDT', '-0.09', '100'),
    }));
    expect(both.legs.short.fundingDaily).toEqual({ status: 'known', value: '-0.1' });
    expect(both.legs.long.fundingDaily).toEqual({ status: 'known', value: '0.3' });
    expect(both.daily).toEqual({ status: 'known', value: '0.2' });

    const zero = estimateFundingScenario(scenario({
      short: leg('BINANCE_FUTURE_BTC_USDT', '0.015', '100'),
      long: leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100'),
    }));
    expect(zero.daily).toEqual({ status: 'known', value: '0' });
    expect(zero.normal.payback).toEqual({ kind: 'none' });

    const reverse = estimateFundingScenario(scenario({
      short: leg('BYBIT_FUTURE_BTC_USDT', '0.015', '100'),
      long: leg('BINANCE_FUTURE_BTC_USDT', '0.03', '110'),
    }));
    expect(reverse.daily).toEqual({ status: 'known', value: '-0.06' });
    expect(reverse.normal.payback).toEqual({ kind: 'none' });
  });

  it('needs a complete window and a valid size and holding period', () => {
    const s = estimateFundingScenario(scenario({ long: leg('BYBIT_FUTURE_BTC_USDT', null, '100') }));
    expect(s.grossDaily).toEqual({ status: 'unknown', reasons: ['long:history-unavailable'] });
    expect(s.normal.oneTime).toEqual({ status: 'known', value: '1.5' });
    expect(s.unknown).toEqual(['long:history-unavailable']);
    for (const bad of [{ quantity: '0' }, { holdDays: '-1' }, { quantity: '1e3' }, { makerPrice: '0' }, { currency: '' }]) {
      expect(() => estimateFundingScenario(scenario(bad))).toThrow('Invalid scenario input');
    }
  });

  it('takes window totals from the ranked history and never changes the score, rank or eligibility', () => {
    const history = publish([historyLeg('BINANCE', 'BTCUSDT', flat('0.0001')), historyLeg('BYBIT', 'BTCUSDT', flat('0.00005'))]);
    const { candidates } = enumerateFundingCandidates([live('BINANCE', 'BTCUSDT'), live('BYBIT', 'BTCUSDT')]);
    const before = rankFundingCandidates({ candidates, history, now: NOW });
    const [top] = before.rows;
    const window = top.windows.find((w) => w.days === 30)!;
    // 90 settlements × 0.0001 and × 0.00005 over 30 days.
    expect([window.result!.short.total, window.result!.long.total]).toEqual(['0.009', '0.0045']);
    const s = estimateFundingScenario(scenario({
      short: leg('BINANCE_FUTURE_BTC_USDT', window.result!.short.total, '100', { fees: fees('0.01', '0.05') }),
      long: leg('BYBIT_FUTURE_BTC_USDT', window.result!.long.total, '100', { fees: fees('0.01', '0.05') }),
    }));
    expect(s.daily).toEqual({ status: 'known', value: '0.015' });
    expect(s.normal.holdResult.status === 'known' && Number(s.normal.holdResult.value) < 0).toBe(true);
    expect(rankFundingCandidates({ candidates, history, now: NOW })).toEqual(before);
    expect(top).toMatchObject({ rank: 1, executionBlockers: [] });
    expect(window.eligible).toBe(true);
  });
});
