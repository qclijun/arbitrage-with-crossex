import { expect, it } from 'vitest';

export function expiredResidualTests(fixture: () => Promise<any>, readReport: (fixture: any, previous?: unknown) => Promise<any>,
  metric: (report: any, id: string) => any, now: number) {
  it.each(['balanced', 'boundary', 'precision', 'unbalanced', 'different-maturity', 'different-base', 'missing-price', 'invalid-price', 'large', 'spread', 'configured', 'recovery', 'recovery-unknown', 'unbalanced-unknown'] as const)(
    'classifies expired residuals conservatively: %s', async kind => {
      const f = await fixture(), positions = f.snapshots.asset.risk.positions;
      const expired = positions.map((position: any, index: number) => ({ ...position, marketId: 196 + index,
        sizeBase: '0.0008313', sizeToken: 0.0008313, maturity: now - 1, notionalUsd: 1.85, notionalUsdExact: '1.85' }));
      if (kind === 'unbalanced' || kind === 'unbalanced-unknown') expired[0].sizeBase = '0.0008314';
      if (kind === 'different-maturity') expired[0].maturity -= 1;
      if (kind === 'different-base') {
        expired[0].base = 'BTC'; expired[0].tokenId = 1;
        expired[0].marketAcc = expired[0].marketAcc.replace('0002ffffff', '0001ffffff');
      }
      if (['missing-price', 'recovery-unknown', 'unbalanced-unknown'].includes(kind)) {
        expired[0].notionalUsd = null; expired[0].notionalUsdExact = null;
      }
      if (kind === 'invalid-price') expired[0].notionalUsdExact = '-1';
      if (kind === 'boundary') { expired[0].notionalUsdExact = '5'; expired[1].notionalUsdExact = '5'; }
      if (kind === 'precision') { expired[0].notionalUsdExact = '5.000000000000000001'; expired[1].notionalUsdExact = '5'; }
      if (kind === 'large') expired[0].notionalUsdExact = '9';
      if (kind === 'spread') expired[0].spreadVenues = ['HYPERLIQUID', 'GATE'];
      if (kind === 'configured') f.snapshots.supplement.settings = {
        thresholds: { 'hedge.maturity_match': [['hedge.maturity_match', 'eq', false, 'CRITICAL']] }, recoveryMarginFraction: .03 };
      positions.push(...expired);
      const previous = kind.startsWith('recovery') ? { scope: f.scope, state: {
        'hedge.maturity_match': { status: 'CRITICAL', criticalMetrics: ['hedge.maturity_match'] } } } : undefined;
      const report = await readReport(f, previous), check = report.checks.find((item: any) => item.id === 'hedge.maturity_match');
      const expected = ['balanced', 'boundary', 'configured', 'recovery'].includes(kind) ? 'OK'
        : ['missing-price', 'invalid-price'].includes(kind) ? 'UNKNOWN' : 'CRITICAL';
      expect(check.status).toBe(expected);
      expect(metric(report, 'hedge.maturity_match').value).toBe(kind === 'recovery-unknown' ? null
        : expected === 'OK' ? true : expected === 'UNKNOWN' ? null : false);
      expect(metric(report, 'hedge.maturity_match').details).toHaveLength(2);
    });
}
