import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import type { FetchLike } from '../../src/core/boros/client';
import { claimReader } from '../../src/server/claim-reads';
import { mockGateGet, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

const ROOT = `0x${'ab'.repeat(20)}`;
const ACC = `${ROOT}000002ffffff`;
afterEach(() => nock.cleanAll());

function read(mode = 'valid') {
  const acc = mode === 'unit' ? `${ROOT}000003ffffff` : ACC;
  mockGateGet('/positions', { body: [] }); mockGateGet('/open_orders', { body: [] }); mockGateGet('/rule/symbols', { body: [] });
  const position: Record<string, unknown> = { marketId: 1, signedSize: '360000000000000001', orders: [] };
  if (mode === 'missing-orders') delete position.orders;
  if (mode === 'active-orders') position.orders = [{ id: 'pending' }];
  if (mode === 'malformed') position.signedSize = 'unknown';
  const fetcher: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    const results = path.endsWith('/markets') ? [{ marketId: 1, tokenId: mode === 'unit' ? 3 : 2,
      imData: { maturity: 2_000_000_000 }, platform: { platformId: 'binance-okx' },
      metadata: { underlyingSymbol: 'ETH', isSpreadMarket: true }, data: {} }]
      : path.endsWith('/market-acc-infos-by-root') ? [{ marketAcc: acc, netBalance: '0', positions: [position] }]
      : [{ marketAcc: acc, marketId: 1 }];
    return { ok: true, status: 200, json: async () => ({ results, ...(mode === 'partial' && !path.endsWith('/markets') ? { resumeToken: 'more' } : {}) }) };
  };
  return claimReader(() => makeClients({ key: TEST_KEY, secret: TEST_SECRET }), () => 100, fetcher,
    () => mode === 'wrong-owner' ? null : ROOT)({ root: ROOT });
}

describe('Boros current ownership evidence', () => {
  it('keeps one physical Spread quantity at 18 decimals with exact account, bucket, market, source directions and maturity', async () => {
    const e = await read();
    expect(e.boros).toHaveLength(1);
    expect(e.boros![0]).toMatchObject({ root: ROOT, accountId: 0, marketAcc: ACC, marketId: 1,
      base: 'ETH', qty: '0.360000000000000001', unit: 'base', maturity: 2_000_000_000,
      sources: [{ venue: 'BINANCE', side: 'long' }, { venue: 'OKX', side: 'short' }] });
  });
  it('preserves an unknown base-unit conversion explicitly instead of treating collateral notional as base', async () => {
    expect((await read('unit')).boros![0].unit).toBe('collateral:USDT');
  });
  it.each(['missing-orders', 'active-orders', 'malformed', 'partial', 'wrong-owner'])('refuses %s evidence', async (mode) => {
    await expect(read(mode)).rejects.toThrow();
  });
});
