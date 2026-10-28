import { describe, expect, it } from 'vitest';
import { purposeFor } from './purpose';

const boros = { base: 'ETH', venues: ['OKX'] };

describe('purposeFor', () => {
  it('declares the Boros strategy only while the ticket is still on its coin', () => {
    expect(purposeFor(boros, 'ETH')).toEqual({ purpose: 'boros-strategy', boros });
    expect(purposeFor(boros, 'eth')).toEqual({ purpose: 'boros-strategy', boros });
    expect(purposeFor(boros, 'BTC')).toEqual({ purpose: 'manual' });
    expect(purposeFor(boros, null)).toEqual({ purpose: 'manual' });
  });

  it('declares a stand-alone open without Boros context', () => {
    expect(purposeFor(null, 'ETH')).toEqual({ purpose: 'manual' });
  });
});
