/**
 * Every POST /deals declares why it opens (ticket 19). The declaration picks
 * a gate; it never grants a privilege, never downgrades to an older protocol,
 * and a reduce-only label never vouches for a leg that adds risk.
 */
import { describe, expect, it } from 'vitest';
import { classifyDealPurpose } from '../../src/server/dealPurpose';

const NOW = Date.UTC(2026, 9, 28);
const open = { a: { symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY' as const }, b: { symbol: 'OKX_FUTURE_ETH_USDT', side: 'SELL' as const } };
const close = {
  a: { symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'SELL' as const, reduceOnly: true },
  b: { symbol: 'OKX_FUTURE_ETH_USDT', side: 'BUY' as const, reduceOnly: true },
};
const boros = { base: 'ETH', venues: ['BINANCE', 'OKX'], maturity: NOW / 1000 + 86_400, marketIds: [198, 196], route: 'singles' };

const refusal = (body: object) => {
  const d = classifyDealPurpose(body);
  if (d.ok) throw new Error(`expected a refusal, got ${JSON.stringify(d)}`);
  return d;
};

describe('classifyDealPurpose', () => {
  it('refuses an opening request from a client that predates purposes, saying to reload', () => {
    const d = refusal(open);
    expect(d).toMatchObject({ status: 400, label: 'client-outdated' });
    expect(d.message).toMatch(/reload/i);
  });

  it('accepts a close from any client — reduce-only legs are verified against live positions later', () => {
    expect(classifyDealPurpose(close)).toEqual({ ok: true, purpose: 'reduce', context: null });
    expect(classifyDealPurpose({ ...close, purpose: 'reduce' })).toEqual({ ok: true, purpose: 'reduce', context: null });
  });

  it("never lets a 'reduce' label cover a leg that adds risk, nor another label cover a close", () => {
    expect(refusal({ ...open, purpose: 'reduce' }).label).toBe('purpose-mismatch');
    expect(refusal({ a: close.a, b: open.b, purpose: 'reduce' }).label).toBe('purpose-mismatch');
    expect(refusal({ ...close, purpose: 'manual' }).label).toBe('purpose-mismatch');
  });

  it('admits a stand-alone open as manual, for the conflict gate to judge', () => {
    expect(classifyDealPurpose({ ...open, purpose: 'manual' })).toEqual({ ok: true, purpose: 'manual', context: null });
    expect(classifyDealPurpose({ a: open.a, purpose: 'manual' })).toMatchObject({ ok: true, purpose: 'manual' });
  });

  it('admits a Boros-strategy open only with its Boros context, kept verbatim', () => {
    expect(classifyDealPurpose({ ...open, purpose: 'boros-strategy', boros })).toEqual({ ok: true, purpose: 'boros-strategy', context: boros });
    expect(classifyDealPurpose({ ...open, purpose: 'boros-strategy', boros: { base: 'eth', venues: ['OKX'] } }))
      .toMatchObject({ ok: true, context: { base: 'eth', venues: ['OKX'] } });
  });

  it.each([
    ['missing', undefined],
    ['without venues', { base: 'ETH', venues: [] }],
    ['for another coin', { ...boros, base: 'BTC' }],
    ['with a fractional maturity', { ...boros, maturity: 1.5 }],
    ['with a non-integer market id', { ...boros, marketIds: [1.5] }],
    ['with an unknown route', { ...boros, route: 'triangle' }],
    ['with a blank venue', { ...boros, venues: [' '] }],
  ])('refuses a Boros-strategy open whose context is %s', (_name, context) => {
    expect(refusal({ ...open, purpose: 'boros-strategy', boros: context }).label).toBe('boros-context-invalid');
  });

  it('refuses Boros context on a request that does not claim the strategy', () => {
    expect(refusal({ ...open, purpose: 'manual', boros }).label).toBe('boros-context-invalid');
  });

  it('sends funding-opportunity opens to their own admission, never through /deals', () => {
    expect(refusal({ ...open, purpose: 'funding-two-leg' })).toMatchObject({ status: 409, label: 'funding-admission-required' });
  });

  it('refuses a purpose it does not know rather than guessing one', () => {
    expect(refusal({ ...open, purpose: 'floating' })).toMatchObject({ status: 400, label: 'purpose-unknown' });
    expect(refusal({ ...open, purpose: 7 })).toMatchObject({ status: 400, label: 'purpose-unknown' });
  });
});
