import { describe, expect, it } from 'vitest';
import { contracts, evaluateRisk, rules, type MetricEvidence, type RiskScope } from '../../web/src/lib/risk';

const scope: RiskScope = { credentialId: 'account-a', address: '0x' + '1'.repeat(40), accountId: 0, pool: 'ETH-cross' };
const now = 1800000000;
const evidence = (value: unknown, extra = {}): MetricEvidence => ({ value, unit: 'ratio', source: 'synthetic official read', evidence: 'fixture', observedAt: now, ttlSeconds: 3600, scope, complete: true, ...extra });
const run = (value: unknown, previous = {}) => evaluateRisk(scope, { 'gate.im_coverage': evidence(value) }, now, previous);
describe('Risk catalog evaluation', () => {
  it('pauses market trading restrictions without suppressing other risk checks', () => {
    const report = evaluateRisk(scope, {}, now, {
      'market.trading_status': { status: 'CRITICAL', criticalMetrics: ['market.trading_status'] },
    });
    expect(rules.find(r => r.id === 'market.trading_status')?.enabled).toBe(false);
    expect(report.checks.some(c => c.id === 'market.trading_status')).toBe(false);
    expect(report.state['market.trading_status']).toBeUndefined();
    expect(report.checks.some(c => c.id === 'rollover.days_to_maturity')).toBe(true);
    expect(report.checks.some(c => c.id === 'data.age_seconds')).toBe(true);
  });
  it('keeps strict boundaries and reapplies them after prior critical status', () => {
    expect(run(1.1).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('WARNING');
    const critical = run(1.09);
    expect(critical.checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('CRITICAL');
    expect(run(1.11, critical.state).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('WARNING');
    const lost = run(null, critical.state);
    expect(lost.checks.find(c => c.id === 'gate.im_coverage')).toMatchObject({ status: 'CRITICAL', coverageComplete: false });
    expect(run(1.4, lost.state).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('OK');
  });
  it('accounts for every enabled check and metric, and rejects foreign/expired evidence', () => {
    const report = run(2);
    expect(report.checks).toHaveLength(rules.filter(r => r.enabled !== false).length);
    expect(new Set(report.checks.flatMap(c => Object.keys(c.metrics))).size).toBe(59);
    for (const extra of [{ observedAt: now + 1 }, { observedAt: now - 3601 }, { unit: 'USD' }, { scope: { ...scope, credentialId: 'b' } }, { complete: false }]) {
      expect(evaluateRisk(scope, { 'gate.im_coverage': evidence(2, extra) }, now).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('UNKNOWN');
    }
    for (const value of ['2', true, NaN, Infinity]) expect(run(value).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('UNKNOWN');
    expect(contracts['gate.im_coverage'].unit).toBe('ratio');
  });
  it('rejects malformed enums/counts/timestamps and lets only fresh proven lower bounds establish danger', () => {
    for (const [id, value] of [['agent.approval', 'connected'], ['execution.halted_count', -1], ['execution.halted_count', 1.5],
      ['monitor.last_complete_run_at', now + 1]] as const) {
      const metrics = { [id]: evidence(value, { unit: contracts[id].unit }) };
      const check = evaluateRisk(scope, metrics, now).checks.find(c => Object.keys(c.metrics).includes(id))!;
      expect(check.status).toBe('UNKNOWN');
    }
    const bound = evidence(1, { unit: 'ETH', lowerBound: true, complete: false, reason: 'Incomplete coverage' });
    const run = (extra = {}) => evaluateRisk(scope, { 'execution.unhedged_eth': { ...bound, ...extra } }, now).checks.find(c => c.id === 'execution.unhedged_eth')!;
    expect(run()).toMatchObject({ status: 'CRITICAL', coverageComplete: false });
    for (const extra of [{ value: 0 }, { observedAt: now + 1 }, { observedAt: now - 3601 }, { unit: 'USD' }, { scope: { ...scope, credentialId: 'other' } }]) expect(run(extra).status).toBe('UNKNOWN');
    const unsafeMinimum = evidence(.1, { unit: 'ratio', lowerBound: true, complete: false });
    expect(evaluateRisk(scope, { 'gate.im_coverage': unsafeMinimum }, now).checks.find(c => c.id === 'gate.im_coverage')?.status).toBe('UNKNOWN');
  });
});
