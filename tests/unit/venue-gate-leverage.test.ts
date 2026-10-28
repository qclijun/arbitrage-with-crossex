/** The Gate adapter's leverage calls (ticket 12): a refusal is definite only
 * for a 4xx leverage-class label; everything else is unknown, for the
 * engine's read-back to settle. */
import { describe, expect, it } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { gateVenue } from '../../src/engine/venueGate';

const httpError = (status: number, label: string) => Object.assign(new Error(label), { response: { status, data: { label, message: `${label} msg` } } });

function venueWith(crossEx: Record<string, unknown>) {
  return gateVenue(() => ({ crossEx }) as unknown as Clients);
}

describe('gateVenue leverage', () => {
  it('sends the decimal string and classifies the answer', async () => {
    const sent: unknown[] = [];
    const ok = venueWith({ updateCrossexPositionsLeverage: async (opts: { crossexLeverageRequest: unknown }) => { sent.push(opts.crossexLeverageRequest); return { body: {} }; } });
    expect(await ok.setLeverage('OKX_FUTURE_ETH_USDT', '5')).toEqual({ kind: 'ok' });
    expect(sent).toEqual([expect.objectContaining({ symbol: 'OKX_FUTURE_ETH_USDT', leverage: '5' })]);

    const refused = venueWith({ updateCrossexPositionsLeverage: async () => { throw httpError(400, 'LEVERAGE_TOO_HIGH'); } });
    expect(await refused.setLeverage('OKX_FUTURE_ETH_USDT', '50')).toEqual({ kind: 'reject', label: 'LEVERAGE_TOO_HIGH', message: 'LEVERAGE_TOO_HIGH msg' });

    for (const err of [httpError(502, 'LEVERAGE_TOO_HIGH'), httpError(400, 'TOO_MANY_REQUESTS'), new Error('socket hang up')]) {
      const unknown = venueWith({ updateCrossexPositionsLeverage: async () => { throw err; } });
      expect((await unknown.setLeverage('OKX_FUTURE_ETH_USDT', '5')).kind).toBe('unknown');
    }
  });

  it('reads one contract, and anything unusable reads as null', async () => {
    const read = (body: unknown) => venueWith({ getCrossexPositionsLeverage: async () => ({ body }) }).readLeverage('OKX_FUTURE_ETH_USDT');
    expect(await read({ OKX_FUTURE_ETH_USDT: '10' })).toBe('10');
    expect(await read({ OKX_FUTURE_ETH_USDT: 7 })).toBe('7');
    expect(await read({})).toBeNull();
    expect(await read({ OKX_FUTURE_ETH_USDT: 'NaN' })).toBeNull();
    const failing = venueWith({ getCrossexPositionsLeverage: async () => { throw new Error('down'); } });
    expect(await failing.readLeverage('OKX_FUTURE_ETH_USDT')).toBeNull();
  });
});
