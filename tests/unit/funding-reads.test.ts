/** The Gate read port behind funding previews (ticket 12): reads only, and a
 * one-sided FX book is a failure, never a rate. */
import { describe, expect, it } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { gateFundingReads } from '../../src/server/funding/reads';

describe('gateFundingReads', () => {
  it('reads rules and leverage for the exact symbols, and the FX book top', async () => {
    const asked: unknown[] = [];
    const clients = {
      crossEx: {
        listCrossexRuleSymbols: async (opts: unknown) => { asked.push(opts); return { body: [{ symbol: 'A' }] }; },
        getCrossexPositionsLeverage: async (opts: unknown) => { asked.push(opts); return { body: { A: '5' } }; },
      },
      spot: { listOrderBook: async (pair: string) => ({ body: pair === 'USDC_USDT' ? { current: 1_700_000_000_000, bids: [['0.9998', '1']], asks: [['1.0002', '1']] } : { bids: [], asks: [['1', '1']] } }) },
    } as unknown as Clients;
    const reads = gateFundingReads(() => clients);
    expect(await reads.rules(['A', 'B'])).toEqual([{ symbol: 'A' }]);
    expect(await reads.leverage(['A', 'B'])).toEqual({ A: '5' });
    expect(asked).toEqual([{ symbols: 'A,B' }, { symbols: 'A,B' }]);
    expect(await reads.spotTop('USDC_USDT')).toEqual({ bid: '0.9998', ask: '1.0002', at: 1_700_000_000_000 });
    await expect(reads.spotTop('X_Y')).rejects.toThrow(/one-sided/);
  });
});
