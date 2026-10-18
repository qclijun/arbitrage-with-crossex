import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { canonicalRiskIdentity, fundingGapFingerprint, type RiskBorosPosition } from '../../src/core/risk';
import { producerConfigId } from '../../src/server/routes/riskEvidence';

const root = '0x' + '1'.repeat(40);
function python(script: string, input: unknown) {
  const result = spawnSync('python3', ['-c', `import json,sys\nsys.path.insert(0,'scripts')\nfrom risk_monitor import producer_scope, canonical_identity, record_funding_gap\nvalue=json.loads(sys.argv[1])\n${script}`, JSON.stringify(input)], { encoding: 'utf8', timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
describe('independent producer scope and continuous gap evidence', () => {
  it('records OKX funding gaps across multiple expiries with the same shared fingerprint', () => {
    const perps = [{ symbol: 'OKX_FUTURE_ETH_USDT', exchange: 'OKX', side: 'LONG', qty: 4 }];
    const boros = [198, 213].map((marketId, i) => ({ marketAcc: root + '000002ffffff', marketId, venue: 'OKX',
      side: 'LONG', sizeToken: 1, maturity: 1801000000 + i * 86400 }));
    const data = { farm: { risk: { address: root, accountId: 0, positionsComplete: true, positions: boros } },
      positions: { positions: [{ symbol: perps[0].symbol, positionQty: '4' }], exposure: [{ base: 'ETH', legs: perps }] } };
    const output = python(`state={}\nc={'root':'${root}'}\nrecord_funding_gap(value,c,state,1800000000)\nrecord_funding_gap(value,c,state,1800000301)\nprint(json.dumps(state['funding_gap']))`, data);
    expect(output).toMatchObject({ uncovered_eth: 2, started_at: 1800000000, observed_at: 1800000301 });
    expect(output.fingerprint).toBe(fundingGapFingerprint(perps, boros as RiskBorosPosition[], { address: root, accountId: 0, credentialId: 'fixture', pool: 'account' }));
  });
  it('uses identical numeric/configuration identities across Python and JavaScript', () => {
    const configs = [1, 1e-7, 1e-9, .03, -0, 1e20].map(value => ({ root, recovery_margin_fraction: value,
      thresholds: { 'gate.im_coverage': [['gate.im_coverage', 'lt', value, 'CRITICAL']] } }));
    const ids = python("print(json.dumps([producer_scope(c, {'account':{'userId':'fixture'}})['config_id'] for c in value]))", configs);
    expect(ids).toEqual(configs.map(c => producerConfigId(c, root)));
    const numeric = [1, 1e-7, 1e-9, .03, -0, 1e20, true, null, '1'];
    expect(python('print(json.dumps(canonical_identity(value)))', numeric)).toBe(canonicalRiskIdentity(numeric));
  });
  it('starts history in the independent producer, preserves exact gaps, and breaks continuity on changes/partial reads', () => {
    const perps = [{ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', side: 'SHORT', qty: 3 }];
    const boros = [{ marketAcc: root + '000002ffffff', marketId: 128, venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 2, maturity: 1801000000 }];
    const data = { farm: { risk: { address: root, accountId: 0, positionsComplete: true, positions: boros } }, positions: { positions: [{ symbol: perps[0].symbol, positionQty: '-3' }], exposure: [{ base: 'ETH', legs: perps }] } };
    const output = python(`state={}\nc={'root':'${root}'}\nrecord_funding_gap(value,c,state,1800000000)\na=dict(state['funding_gap'])\nrecord_funding_gap(value,c,state,1800000100)\nb=dict(state['funding_gap'])\nvalue['farm']['risk']['positions'][0]['sizeToken']=1\nrecord_funding_gap(value,c,state,1800000200)\nc1=dict(state['funding_gap'])\nvalue['farm']['risk']['positionsComplete']=False\nrecord_funding_gap(value,c,state,1800000300)\nprint(json.dumps([a,b,c1,state]))`, data);
    expect(output[0].started_at).toBe(1800000000);
    expect(output[0].fingerprint).toBe(fundingGapFingerprint(perps, boros as RiskBorosPosition[], { address: root, accountId: 0, credentialId: 'fixture', pool: 'ETH-cross' }));
    expect(output[1].started_at).toBe(1800000000);
    expect(output[2].started_at).toBe(1800000200);
    expect(output[3].funding_gap).toBeUndefined();
  });
  it('supports an agent-derived root and restarts duration when expiry enlarges an existing gap', () => {
    const data = { agent: { root }, farm: { risk: { address: root, accountId: 0, positionsComplete: true,
      positions: [{ marketAcc: root + '000002ffffff', marketId: 128, venue: 'HYPERLIQUID', side: 'SHORT', sizeToken: 2, maturity: 1800000050 }] } },
      positions: { positions: [{ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionQty: '-3' }],
        exposure: [{ base: 'ETH', legs: [{ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', side: 'SHORT', qty: 3 }] }] } };
    const output = python("state={}\nrecord_funding_gap(value,{},state,1800000000)\na=dict(state['funding_gap'])\nrecord_funding_gap(value,{},state,1800000100)\nprint(json.dumps([a,state['funding_gap']]))", data);
    expect(output[0]).toMatchObject({ uncovered_eth: 1, started_at: 1800000000 });
    expect(output[1]).toMatchObject({ uncovered_eth: 3, started_at: 1800000100 });
  });
});
