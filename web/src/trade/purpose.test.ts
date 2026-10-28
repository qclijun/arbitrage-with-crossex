import { describe, expect, it } from 'vitest';
import { borosContext, purposeFor } from './purpose';

const arm = { context: { base: 'ETH', venues: ['OKX'] }, legs: 'OKX_FUTURE_ETH_USDT|BUY' };

describe('purposeFor', () => {
  it('declares the Boros strategy only while the ticket is on the legs it armed', () => {
    expect(purposeFor(arm, 'OKX_FUTURE_ETH_USDT|BUY')).toEqual({ purpose: 'boros-strategy', boros: arm.context });
    expect(purposeFor(arm, 'OKX_FUTURE_ETH_USDT|SELL')).toEqual({ purpose: 'manual' });
    expect(purposeFor(arm, 'GATE_FUTURE_ETH_USDT|BUY')).toEqual({ purpose: 'manual' });
  });

  it('declares a stand-alone open without a strategy arm', () => {
    expect(purposeFor(null, 'OKX_FUTURE_ETH_USDT|BUY')).toEqual({ purpose: 'manual' });
  });
});

describe('borosContext', () => {
  it('names each venue once and omits an unknown maturity', () => {
    expect(borosContext('ETH', ['OKX', 'OKX'])).toEqual({ base: 'ETH', venues: ['OKX'] });
    expect(borosContext('ETH', ['OKX', 'GATE'], 1_900_000_000)).toEqual({ base: 'ETH', venues: ['OKX', 'GATE'], maturity: 1_900_000_000 });
  });
});
