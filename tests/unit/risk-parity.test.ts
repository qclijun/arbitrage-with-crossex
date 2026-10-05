import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { contracts, evaluateRisk, rules, type MetricEvidence, type RiskScope, type RiskState } from '../../web/src/lib/risk';
const now = 1800000000;
const scope: RiskScope = { credentialId: 'synthetic', address: '0x' + '1'.repeat(40), accountId: 0, pool: 'ETH-cross' };
const defaultValue = (id: string): unknown => {
  const c = contracts[id];
  if (c.type === 'bool') return id !== 'data.stale';
  if (c.type === 'enum') return c.values![0];
  if (c.unit === 'unix seconds') return now - 30;
  if (c.positive) return 1;
  return 0;
};
interface Scenario { id: string; observations: Record<string, Record<string, unknown>>; previous?: string[]; status?: string }
function measurements(s: Scenario): Record<string, MetricEvidence> {
  return Object.fromEntries(Object.entries(s.observations).map(([id, e]) => [id, { value: e.value, unit: e.unit as string, source: e.source as string,
    evidence: e.evidence as string, observedAt: e.observed_at as number, ttlSeconds: e.ttl_seconds as number, scope, complete: true }]));
}
function fixture(id: string): Scenario {
  const rule = rules.find(r => r.id === id)!;
  return { id, observations: Object.fromEntries(rule.metrics.map(k => [k, { value: defaultValue(k), unit: contracts[k].unit,
    source: 'synthetic reference source', evidence: 'parity fixture', observed_at: now, ttl_seconds: contracts[k].max_age_seconds }])) };
}
describe('shared synthetic evidence against current Python monitor', () => {
  it('matches collector and notification runtime states without trusting manually recorded runtime metrics', () => {
    const script = `import json,sys\nfrom pathlib import Path\nsys.path.insert(0,'scripts')\nfrom risk_monitor import evaluate\nrules=json.loads(Path('scripts/risk-monitor-rules.json').read_text())\nout=[]\nfor failures in [0,1,2,3,5]:\n for age in [0,300,660,1000]:\n  for notify in [0,1,3]:\n   state={'service_failures':max(0,failures-1),'last_complete_run_at':${now}-age,'pending':{str(i):{} for i in range(notify)},'notify_failures':notify,'notify_last_success':${now}-30}\n   report=evaluate({'health':{'status':'ok' if failures==0 else 'down'}},{'observations_file':'/nonexistent-risk-parity'},state,[r for r in rules if r['id'] in ['service.http_ok','notify.last_success_at']],${now},{'fixture':'failure'} if failures else {})\n   out.extend(report['checks'])\nprint(json.dumps(out))`;
    const python = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
    expect(python.status, python.stderr).toBe(0);
    for (const reference of JSON.parse(python.stdout)) {
      const metrics = Object.fromEntries(Object.entries(reference.metrics).map(([id, value]) => {
        const e = value as { value: unknown; observedAt: number };
        return [id, { value: e.value, unit: contracts[id].unit, source: 'independent runtime fixture', evidence: 'confirmed producer state',
          observedAt: e.observedAt, ttlSeconds: contracts[id].max_age_seconds, scope, complete: true }];
      }));
      expect(evaluateRisk(scope, metrics, now).checks.find(c => c.id === reference.id)?.status).toBe(reference.status);
    }
  });
  it('matches numeric boundaries, bool/enum predicates, units, missing evidence and unresolved critical triggers across the enabled catalog', () => {
    const scenarios: Scenario[] = [];
    for (const rule of rules.filter(r => r.enabled !== false && !r.id.startsWith('service.') && !r.id.startsWith('notify.'))) {
      scenarios.push(fixture(rule.id));
      for (const [metric, op, threshold] of rule.conditions) {
        const values = typeof threshold === 'number' ? [threshold - Math.max(1e-6, Math.abs(threshold) * 1e-6), threshold, threshold + Math.max(1e-6, Math.abs(threshold) * 1e-6)]
          : typeof threshold === 'boolean' ? [true, false] : contracts[metric].values ?? [threshold];
        for (const value of values) {
          const s = fixture(rule.id); s.observations[metric].value = value;
          // Derived quote/review measurements must describe the same observation.
          if (metric.endsWith('_deviation')) {
            const quote = metric.replace('_deviation', '_usd'); s.observations[quote].value = 1 + (value as number);
            s.observations[metric].value = Math.abs((s.observations[quote].value as number) - 1);
          }
          if (metric.endsWith('.review_age_h')) {
            const observed = now - (value as number) * 3600;
            s.observations[metric.replace('.review_age_h', '.incident_status')].observed_at = observed;
            s.observations[metric].observed_at = observed;
          }
          if (op === 'abs_gt' && typeof value === 'number') s.observations[metric].value = -value;
          scenarios.push(s);
        }
      }
      const missing = fixture(rule.id); for (const m of rule.metrics) missing.observations[m].value = null;
      const critical = rule.conditions.filter(c => c[3] === 'CRITICAL').map(c => c[0]);
      scenarios.push(missing, { ...missing, previous: critical, status: 'CRITICAL' });
    }
    for (const value of [1.11, 1.14, 1.25]) {
      const s = fixture('gate.im_coverage'); s.observations['gate.im_coverage'].value = value;
      scenarios.push({ ...s, previous: ['gate.im_coverage'], status: 'CRITICAL' });
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'risk-parity-'));
    try {
      const file = path.join(dir, 'cases.json'); writeFileSync(file, JSON.stringify(scenarios));
      const script = `import json,sys\nfrom pathlib import Path\nsys.path.insert(0,'scripts')\nfrom risk_monitor import evaluate\nrules=json.loads(Path('scripts/risk-monitor-rules.json').read_text())\ncases=json.loads(Path(sys.argv[1]).read_text())\nout=[]\nfor case in cases:\n p=Path(sys.argv[1]).with_name('observations.json');p.write_text(json.dumps({'metrics':case['observations']}))\n state={'last_complete_run_at':${now - 30},'risk_status':{case['id']:case.get('status','OK')},'critical_metrics':{case['id']:case.get('previous',[])}}\n result=evaluate({}, {'observations_file':str(p)}, state,[r for r in rules if r['id']==case['id']], ${now})\n out.append(result['checks'][0]['status'])\nprint(json.dumps(out))`;
      const python = spawnSync('python3', ['-c', script, file], { encoding: 'utf8' });
      expect(python.status, python.stderr).toBe(0);
      const expected = JSON.parse(python.stdout) as string[];
      scenarios.forEach((s, i) => {
        const previous: RiskState = s.previous ? { [s.id]: { status: 'CRITICAL', criticalMetrics: s.previous } } : {};
        const actual = evaluateRisk(scope, measurements(s), now, previous).checks.find(c => c.id === s.id)!.status;
        expect(actual, `${s.id} scenario ${i}: ${JSON.stringify(s.observations)}`).toBe(expected[i]);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
