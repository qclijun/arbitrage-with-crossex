/** The Gate read port behind funding previews (ticket 12): reads only. */
import { describe, expect, it } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { gateFundingReads } from '../../src/server/funding/reads';

describe('gateFundingReads', () => {
  it('reads rules and leverage for the exact symbols', async () => {
    const asked: unknown[] = [];
    const clients = {
      crossEx: {
        listCrossexRuleSymbols: async (opts: unknown) => { asked.push(opts); return { body: [{ symbol: 'A' }] }; },
        getCrossexPositionsLeverage: async (opts: unknown) => { asked.push(opts); return { body: { A: '5' } }; },
      },
    } as unknown as Clients;
    const reads = gateFundingReads(() => clients);
    expect(await reads.rules(['A', 'B'])).toEqual([{ symbol: 'A' }]);
    expect(await reads.leverage(['A', 'B'])).toEqual({ A: '5' });
    expect(asked).toEqual([{ symbols: 'A,B' }, { symbols: 'A,B' }]);
  });
});
