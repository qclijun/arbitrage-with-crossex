import { describe, expect, it } from 'vitest';
import { accountSettlementWindow, netSettlementWindow } from '../../src/core/boros/riskSettlement';
import type { BorosSettlementRow } from '../../src/core/boros/client';
const root = '0x' + 'ab'.repeat(20);
const now = 1800000000;
const row = (id: string, timeSec: number, settlementToken: number): BorosSettlementRow => ({
  id, timeSec, settlementToken, marketAcc: root + '000002ffffff', tokenId: 2, marketId: 128,
  feeToken: .001, positionAbs: 3, settlementRate: .1,
});
describe('selected ETH cross-pool net settlement', () => {
  it('retains signed independent cross/isolated ETH and BTC pools without mixing units', () => {
    const isolated = { ...row('isolated', now, -.02), marketAcc: root + '000002000080' };
    const btc = { ...row('btc', now, -.0001), marketAcc: root + '000001ffffff', tokenId: 1 };
    const result = accountSettlementWindow({ rows: [row('eth', now, .01), isolated, btc, btc], coversFromSec: 0 }, root, 0, now);
    expect(result.complete).toBe(true);
    expect(result.pools).toEqual([
      { marketAcc: root + '000002ffffff', tokenId: 2, netToken: .01 },
      { marketAcc: root + '000002000080', tokenId: 2, netToken: -.02 },
      { marketAcc: root + '000001ffffff', tokenId: 1, netToken: -.0001 },
    ]);
  });
  it('uses net amounts once, includes closed markets, and keeps rolling boundaries', () => {
    const a = row('a', now - 1, -.012);
    expect(netSettlementWindow({ rows: [a, a, row('b', now, .002), row('old', now - 86400, -1)], coversFromSec: 0 }, root, 0, now)).toMatchObject({ netEth: -.01, complete: true });
    expect(netSettlementWindow({ rows: [], coversFromSec: 0 }, root, 0, now)).toMatchObject({ netEth: 0, complete: true });
  });
  it('does not establish zero from partial, foreign, conflicted or malformed evidence', () => {
    for (const ledger of [
      { rows: [], coversFromSec: now - 10 },
      { rows: [row('a', now, -.01), row('a', now, -.02)], coversFromSec: 0 },
      { rows: [{ ...row('a', now, 1), marketAcc: 'broken' }], coversFromSec: 0 },
      { rows: [{ ...row('a', now, 1), settlementToken: NaN }], coversFromSec: 0 },
      { rows: [row('future', now + 1, 1)], coversFromSec: 0 },
      { rows: [{ ...row('wallet', now, 1), marketAcc: '0x' + 'cd'.repeat(20) + '000002ffffff' }], coversFromSec: 0 },
      { rows: [{ ...row('account', now, 1), marketAcc: root + '010002ffffff' }], coversFromSec: 0 },
      { rows: [], coversFromSec: 0, validationError: 'truncated page' },
    ]) expect(netSettlementWindow(ledger, root, 0, now)).toMatchObject({ netEth: null, complete: false });
  });
  it('excludes other valid pools rather than spending their collateral', () => {
    const isolated = { ...row('isolated', now, -1), marketAcc: root + '000002000080' };
    const btc = { ...row('btc', now, -1), marketAcc: root + '000001ffffff', tokenId: 1 };
    expect(netSettlementWindow({ rows: [isolated, btc], coversFromSec: 0 }, root, 0, now)).toMatchObject({ netEth: 0, complete: true });
  });
});
