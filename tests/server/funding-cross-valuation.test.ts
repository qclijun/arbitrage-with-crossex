import { afterEach, expect, it } from 'vitest';
import { fundingWorld, type FundingWorld } from '../helpers/funding-intent-fixture';

let world: FundingWorld | undefined;
afterEach(async () => { await world?.app.close(); });
const hl = { venue: 'HYPERLIQUID', contractId: 'ETH', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' };
const okx = { venue: 'OKX', contractId: 'ETH-USDT-SWAP', symbol: 'OKX_FUTURE_ETH_USDT' };

it.each([
  { short: hl, long: okx },
  { short: okx, long: hl },
])('previews a cross-basis pair in either direction with USDC valued at par in USDT', async (legs) => {
  world = fundingWorld();
  const res = await world.preview(legs);
  expect(res.status).toBe(200);
  const { data } = res.body;
  expect(data.blockers).toEqual([]);
  expect(data.previewId).toEqual(expect.any(String));
  expect(data.content).toMatchObject({ currency: 'USDT', fx: 'parity:USDC=USDT' });
  expect(data.content.amounts.daily).toEqual(expect.any(String));
  const hlSide = legs.short === hl ? 'short' : 'long';
  expect(data.scenario.legs[hlSide].fx).toMatchObject({ from: 'USDC', to: 'USDT', rate: '1' });
  expect(world.store.listPairs()).toEqual([]);
  expect(world.venue.createCalls).toEqual([]);
});
