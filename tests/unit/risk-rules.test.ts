import { describe, expect, it } from 'vitest';
import { contracts, evaluateRisk, rules, type MetricEvidence, type RiskScope } from '../../web/src/lib/risk';

const scope: RiskScope = { credentialId: 'account-a', address: '0x' + '1'.repeat(40), accountId: 0, pool: 'ETH-cross' };
const now = 1800000000;
const evidence = (value: unknown, extra = {}): MetricEvidence => ({ value, unit: 'ratio', source: 'synthetic official read', evidence: 'fixture', observedAt: now, ttlSeconds: 3600, scope, complete: true, ...extra });
const run = (value: unknown, previous = {}) => evaluateRisk(scope, { 'gate.im_coverage': evidence(value) }, now, previous);
describe('Risk catalog evaluation', () => {
  it('keeps strict boundaries and requires hysteresis for recovery', () => {
    expect(run(1.1).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('WARNING');
    const critical = run(1.09);
    expect(critical.checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('CRITICAL');
    expect(run(1.11, critical.state).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('CRITICAL');
    const lost = run(null, critical.state);
    expect(lost.checks.find(c => c.id === 'gate.im_coverage')).toMatchObject({ status: 'CRITICAL', coverageComplete: false });
    expect(run(1.4, lost.state).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('OK');
  });
  it('accounts for every enabled check and metric, and rejects foreign/expired evidence', () => {
    const report = run(2);
    expect(report.checks).toHaveLength(rules.filter(r => r.enabled !== false).length);
    expect(new Set(report.checks.flatMap(c => Object.keys(c.metrics))).size).toBe(61);
    for (const extra of [{ observedAt: now + 1 }, { observedAt: now - 3601 }, { unit: 'USD' }, { scope: { ...scope, credentialId: 'b' } }, { complete: false }]) {
      expect(evaluateRisk(scope, { 'gate.im_coverage': evidence(2, extra) }, now).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('UNKNOWN');
    }
    for (const value of ['2', true, NaN, Infinity]) expect(run(value).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('UNKNOWN');
    expect(contracts['gate.im_coverage'].unit).toBe('ratio');
  });
});
