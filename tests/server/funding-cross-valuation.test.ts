import { afterEach, expect, it } from 'vitest';
import { fundingWorld, type FundingWorld } from '../helpers/funding-intent-fixture';

let world: FundingWorld | undefined;
afterEach(async () => { await world?.app.close(); });
const hl = { venue: 'HYPERLIQUID', contractId: 'ETH', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' };
const okx = { venue: 'OKX', contractId: 'ETH-USDT-SWAP', symbol: 'OKX_FUTURE_ETH_USDT' };

it.each([
  { short: hl, long: okx },
  { short: okx, long: hl },
])('blocks cross-basis opens in either direction despite admissible history and an open switch', async (legs) => {
  world = fundingWorld();
  expect(world.store.admission.read().open).toBe(true);
  const res = await world.preview(legs);
  expect(res.status).toBe(200);
  expect(res.body.data.blockers.map((b: { code: string }) => b.code)).toContain('funding-valuation-unnormalized');
  expect(res.body.data.previewId).toBeNull();
  expect(res.body.data.scenario).toBeNull();
  expect(res.body.data.content.amounts.daily).toBeNull();
  expect(world.store.listPairs()).toEqual([]);
  expect(world.venue.createCalls).toEqual([]);
  expect(world.venue.leverageCalls).toEqual([]);
});
