import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/server/cache';
import { producerConfigId } from '../../src/server/routes/riskEvidence';
import { evaluateRisk } from '../../src/core/risk';
import { HOST, makeTestApp } from './helpers/gate-nock';
const root = '0x' + 'ab'.repeat(20), other = '0x' + 'cd'.repeat(20);
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture() {
  const cache = new TtlCache();
  await cache.get('account', 2000, async () => ({ userId: 'gate-user' }));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risk-evidence-'));
  const folder = path.join(dataDir, 'risk-monitor'); mkdirSync(folder);
  const now = Date.now() / 1000;
  const config = { root, terminal_url: 'http://localhost:6688', account_id: 0, base: 'ETH', collateral_token_id: 2, token_file: 'do-not-return-token-path' };
  const scope = { ...config, gate_user_id: 'gate-user', config_id: producerConfigId(config, root) };
  const state = { producer_scope: scope, observed_at: now, service_failures: 0, last_complete_run_at: now - 1000,
    pending: { 'check-a': { secret: 'do-not-return-queue-content' } }, notify_failures: 3, notify_last_success: now - 50,
    notify_last_message_id: 77, uncovered_since: now - 30 };
  const observations = { metrics: { 'stablecoin.usdt_usd': { value: .97, unit: 'USD', observed_at: now, ttl_seconds: 100,
    source: 'independent fixture', evidence: 'review-1', coverage_complete: true, scope } } };
  const heartbeat = { producer_scope: scope, observedAt: now - 10, complete: false, lastCompleteAt: now - 1000 };
  for (const [file, value] of Object.entries({ 'config.json': config, 'state.json': state, 'observations.json': observations, 'heartbeat.json': heartbeat })) writeFileSync(path.join(folder, file), JSON.stringify(value));
  vi.stubEnv('BOROS_ROOT_ADDRESS', root); vi.stubEnv('BOROS_ACCOUNT_ID', '0'); vi.stubEnv('BOROS_AGENT_PRIVATE_KEY', '');
  app = makeTestApp({ cache, dataDir });
  return { now, folder, scope, config, state, cache };
}
describe('scoped read-only Risk evidence API', () => {
  it('keeps confirmed delivery history usable during quiet periods with fresh notification state', async () => {
    const f = await fixture();
    const sentAt = f.now - 86400;
    const state = { ...f.state, pending: {}, notify_failures: 0, notify_last_success: sentAt };
    const clock = vi.spyOn(Date, 'now');
    const reports = [];
    for (const elapsed of [0, 7200, 86400]) {
      const now = f.now + elapsed;
      clock.mockReturnValue(now * 1000);
      writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify({ ...state, observed_at: now }));
      const d = (await app!.inject({ url: `/api/risk/evidence?address=${root}`, headers: HOST })).json().data;
      const check = evaluateRisk(d.scope, d.metrics, now + 1).checks.find(c => c.id === 'notify.last_success_at')!;
      expect(check.status).toBe('OK');
      expect(check.metrics['notify.last_success_at'].value).toBe(sentAt);
      reports.push({ observedAt: now, checks: [check] });
    }
    // Exercise the actual offline notification consumer with API-produced checks.
    const result = spawnSync('python3', ['-c', `import json,sys
sys.path.insert(0,'scripts')
from risk_monitor import notify_report
data=json.load(sys.stdin); state=data['state']; sent=[]
for report in data['reports']:
    notify_report(report,state,{}, {},report['observedAt'],sent.append)
print(json.dumps({'sent':sent,'sendTime':state['notify_last_success'],'pending':state['pending']}))`],
    { input: JSON.stringify({ state, reports }), encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sent: [], sendTime: sentAt, pending: {} });
  });
  it.each(['missing-receipt', 'missing-time', 'future-send', 'send-after-observation', 'expired-state', 'future-state'])('does not turn invalid delivery history into healthy evidence: %s', async kind => {
    const f = await fixture();
    const state = { ...f.state, pending: {}, notify_failures: 0, notify_last_success: f.now - 86400 };
    if (kind === 'missing-receipt') state.notify_last_message_id = 0;
    if (kind === 'missing-time') state.notify_last_success = 0;
    if (kind === 'future-send') state.notify_last_success = f.now + 3600;
    if (kind === 'send-after-observation') { state.observed_at = f.now - 100; state.notify_last_success = f.now - 50; }
    if (kind === 'expired-state') state.observed_at = f.now - 3601;
    if (kind === 'future-state') state.observed_at = f.now + 3600;
    writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify(state));
    const d = (await app!.inject({ url: `/api/risk/evidence?address=${root}`, headers: HOST })).json().data;
    expect(evaluateRisk(d.scope, d.metrics, f.now + 1).checks.find(c => c.id === 'notify.last_success_at')?.status).toBe('UNKNOWN');
  });
  it.each([[1, 'WARNING'], [3, 'CRITICAL']] as const)('preserves notification failure alerts with old confirmed history: %s failures', async (failures, status) => {
    const f = await fixture();
    writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify({ ...f.state, notify_last_success: f.now - 86400, notify_failures: failures }));
    const d = (await app!.inject({ url: `/api/risk/evidence?address=${root}`, headers: HOST })).json().data;
    expect(evaluateRisk(d.scope, d.metrics, f.now + 1).checks.find(c => c.id === 'notify.last_success_at')?.status).toBe(status);
  });
  it.each(['localhost', '127.0.0.1'])('accepts supported loopback aliases for a persisted %s identity', async configuredHost => {
    const f = await fixture();
    const config = { ...f.config, terminal_url: `http://${configuredHost}:6688`, thresholds: { 'gate.im_coverage': [['gate.im_coverage', 'lt', 1.8, 'WARNING']] } };
    const scope = { ...f.scope, terminal_url: config.terminal_url, config_id: producerConfigId(config, root) };
    writeFileSync(path.join(f.folder, 'config.json'), JSON.stringify(config));
    writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify({ ...f.state, producer_scope: scope }));
    writeFileSync(path.join(f.folder, 'heartbeat.json'), JSON.stringify({ producer_scope: scope, observedAt: f.now }));
    const before = readFileSync(path.join(f.folder, 'state.json'), 'utf8');
    for (const host of ['localhost:6688', '127.0.0.1:6688']) {
      const res = await app!.inject({ url: `/api/risk/evidence?address=${root}`, headers: { ...HOST, host } });
      expect(res.statusCode).toBe(200);
      const d = res.json().data;
      expect(d.metrics['service.consecutive_failures'].value).toBe(0);
      expect(d.metrics['monitor.heartbeat_age_s'].value).toBeGreaterThanOrEqual(0);
      expect(d.settings.thresholds).toEqual(config.thresholds);
      expect(d.configuration.configId).toBe(scope.config_id);
    }
    expect(readFileSync(path.join(f.folder, 'state.json'), 'utf8')).toBe(before);
  });
  it.each(['port', 'account', 'subaccount', 'config', 'remote', 'path', 'credentials'])('still rejects foreign terminal evidence: %s', async kind => {
    const f = await fixture();
    const scope = { ...f.scope };
    if (kind === 'port') scope.terminal_url = 'http://localhost:6689';
    if (kind === 'account') scope.gate_user_id = 'other-user';
    if (kind === 'subaccount') scope.account_id = 1;
    if (kind === 'config') scope.config_id = 'foreign-config';
    if (kind === 'remote') scope.terminal_url = 'http://evil.example:6688';
    if (kind === 'path') scope.terminal_url = 'http://localhost:6688/other';
    if (kind === 'credentials') scope.terminal_url = 'http://user@localhost:6688';
    writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify({ ...f.state, producer_scope: scope }));
    writeFileSync(path.join(f.folder, 'heartbeat.json'), JSON.stringify({ producer_scope: scope, observedAt: f.now }));
    const d = (await app!.inject({ url: `/api/risk/evidence?address=${root}`, headers: { ...HOST, host: '127.0.0.1:6688' } })).json().data;
    expect(d.metrics['service.consecutive_failures']).toBeUndefined();
    expect(d.metrics['monitor.heartbeat_age_s']).toBeUndefined();
  });
  it('rejects a different terminal port and retains the existing IPv6 access guard', async () => {
    await fixture();
    const url = `/api/risk/evidence?address=${root}`;
    const d = (await app!.inject({ url, headers: { ...HOST, host: '127.0.0.1:6689' } })).json().data;
    expect(d.metrics).toEqual({});
    expect(d.settings).toBeUndefined();
    expect((await app!.inject({ url, headers: { ...HOST, host: '[::1]:6688' } })).statusCode).toBe(403);
  });
  it('exposes effective configuration and applies scoped thresholds before a collector has run', async () => {
    const f = await fixture();
    const config = { ...f.config, thresholds: { 'gate.im_coverage': [['gate.im_coverage', 'lt', 1.8, 'WARNING']] }, recovery_margin_fraction: .1 };
    writeFileSync(path.join(f.folder, 'config.json'), JSON.stringify(config));
    writeFileSync(path.join(f.folder, 'state.json'), '{}');
    const data = (await app!.inject({ url: `/api/risk/evidence?address=${root}`, headers: HOST })).json().data;
    expect(data.settings).toEqual({ thresholds: config.thresholds, recoveryMarginFraction: .1 });
    expect(data.configuration).toEqual({ configId: producerConfigId(config, root), stateDir: f.folder,
      observationsFile: path.join(f.folder, 'observations.json') });
    expect(data.metrics['notify.pending_count']).toBeUndefined();
  });
  it('separates fresh heartbeat, old complete collection and confirmed delivery without exposing or modifying files', async () => {
    const f = await fixture();
    const before = ['state.json', 'heartbeat.json', 'config.json', 'observations.json'].map(file => readFileSync(path.join(f.folder, file), 'utf8'));
    const res = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${root}`, headers: HOST });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.metrics['monitor.heartbeat_age_s'].value).toBeGreaterThanOrEqual(10);
    expect(data.metrics['service.last_success_age_s'].value).toBeGreaterThanOrEqual(1000);
    expect(data.metrics['monitor.last_complete_run_at'].observedAt).toBe(f.now - 1000);
    expect(evaluateRisk(data.scope, data.metrics, f.now + 1).checks.find(c => c.id === 'monitor.heartbeat_age_s')?.status).toBe('UNKNOWN');
    expect(data.metrics['notify.pending_count'].value).toBe(1);
    expect(data.metrics['notify.failure_streak'].value).toBe(3);
    expect(data.metrics['notify.last_success_at'].value).toBe(f.now - 50);
    expect(data.metrics['notify.last_success_at'].observedAt).toBe(f.now);
    expect(data.metrics['notify.last_success_at'].source).toContain('not a current channel probe');
    expect(data.fundingGapStartedAt).toBeNull(); // legacy start is not current-gap history
    expect(data.metrics['stablecoin.usdt_usd']).toMatchObject({ value: .97, ttlSeconds: 100, unit: 'USD' });
    expect(res.body).not.toContain('do-not-return');
    expect(['state.json', 'heartbeat.json', 'config.json', 'observations.json'].map(file => readFileSync(path.join(f.folder, file), 'utf8'))).toEqual(before);
    const foreign = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${other}`, headers: HOST });
    expect(foreign.json().data.metrics).toEqual({});
    expect(foreign.json().data.baseline).toBeNull();
  });
  it.each(['valid', 'zero', 'missing-leg', 'ambiguous-venue', 'future', 'scope'] as const)('validates and sanitizes the explicit baseline: %s', async kind => {
    const f = await fixture();
    const baseline = { scope: f.scope, boros: { '128': -3, '129': 3 },
      perps: { HYPERLIQUID_FUTURE_ETH_USDC: -3, BINANCE_FUTURE_ETH_USDT: 3 },
      opened_at: f.now - 1000, observed_at: f.now - 10, evidence: 'explicit verified fixture', secret: 'do-not-return-secret' };
    if (kind === 'zero') baseline.boros['128'] = 0;
    if (kind === 'missing-leg') delete (baseline.boros as Record<string, number>)['129'];
    if (kind === 'ambiguous-venue') (baseline.perps as Record<string, number>).HYPERLIQUID_FUTURE_ETH_USDT = -3;
    if (kind === 'future') baseline.observed_at = f.now + 1000;
    if (kind === 'scope') baseline.scope = { ...f.scope, root: other };
    writeFileSync(path.join(f.folder, 'config.json'), JSON.stringify({ ...f.config, baseline }));
    const res = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${root}`, headers: HOST });
    expect(res.body).not.toContain('do-not-return');
    const result = res.json().data.baseline;
    if (kind === 'valid') expect(Object.keys(result).sort()).toEqual(['boros', 'evidence', 'observed_at', 'opened_at', 'perps']);
    else expect(result).toBeNull();
  });
  it('defaults omitted units, rejects raw metric payloads and enforces receipt/time/coverage contracts', async () => {
    const f = await fixture();
    const obs = { source: 'fixture', evidence: 'review', scope: f.scope, observed_at: f.now, ttl_seconds: 120, coverage_complete: true };
    writeFileSync(path.join(f.folder, 'observations.json'), JSON.stringify({ metrics: {
      'stablecoin.usdt_usd': { ...obs, value: .97 },
      'stablecoin.usdc_usd': { ...obs, value: { secret: 'do-not-return-raw' } },
    } }));
    writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify({ ...f.state, notify_last_message_id: null }));
    const res = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${root}`, headers: HOST });
    const d = res.json().data;
    expect(res.body).not.toContain('do-not-return');
    expect(d.metrics['stablecoin.usdt_usd']).toMatchObject({ value: .97, unit: 'USD' });
    expect(d.metrics['stablecoin.usdc_usd'].value).toBeNull();
    expect(d.metrics['notify.last_success_at'].value).toBeNull();
    expect(evaluateRisk(d.scope, d.metrics, f.now).checks.find(c => c.id === 'notify.last_success_at')?.status).toBe('CRITICAL');
  });
  it.each(['future', 'expired', 'unit', 'type', 'partial', 'scope'] as const)('rejects invalid independent evidence: %s', async kind => {
    const f = await fixture();
    const obs = { source: 'fixture', evidence: 'review', scope: f.scope, observed_at: f.now, ttl_seconds: 120, coverage_complete: true, unit: 'USD', value: 1 as unknown };
    if (kind === 'future') obs.observed_at += 1000;
    if (kind === 'expired') obs.observed_at -= 121;
    if (kind === 'unit') obs.unit = 'ETH';
    if (kind === 'type') obs.value = '1';
    if (kind === 'partial') obs.coverage_complete = false;
    if (kind === 'scope') obs.scope = { ...f.scope, account_id: 1 };
    writeFileSync(path.join(f.folder, 'observations.json'), JSON.stringify({ metrics: { 'stablecoin.usdt_usd': obs } }));
    const res = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${root}`, headers: HOST });
    const d = res.json().data;
    expect(evaluateRisk(d.scope, d.metrics, f.now).checks.find(c => c.id === 'stablecoin.usdt_usd')?.status).toBe('UNKNOWN');
  });
  it('rejects unscoped legacy records, missing delivery confirmation and forged configuration identity', async () => {
    const f = await fixture();
    writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify({ ...f.state, producer_scope: { ...f.scope, config_id: 'wrong' } }));
    writeFileSync(path.join(f.folder, 'heartbeat.json'), JSON.stringify({ observedAt: f.now }));
    const res = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${root}`, headers: HOST });
    expect(res.json().data.metrics['notify.pending_count']).toBeUndefined();
    expect(res.json().data.metrics['monitor.heartbeat_age_s']).toBeUndefined();
  });
  it('inherits authentication and Host/Origin guards and never treats no deployment as zero failures', async () => {
    app = makeTestApp();
    const request = { method: 'GET' as const, url: `/api/risk/evidence?address=${root}` };
    expect((await app.inject({ ...request, headers: { host: 'localhost:6688' } })).statusCode).toBe(401);
    expect((await app.inject({ ...request, headers: { ...HOST, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ ...request, headers: HOST })).json().data.metrics).toEqual({});
  });
  it('does not refresh or accept future producer state/heartbeat timestamps', async () => {
    const f = await fixture();
    writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify({ ...f.state, observed_at: f.now + 3600 }));
    writeFileSync(path.join(f.folder, 'heartbeat.json'), JSON.stringify({ producer_scope: f.scope, observedAt: f.now + 3600 }));
    const res = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${root}`, headers: HOST });
    expect(res.json().data.metrics['monitor.heartbeat_age_s']).toBeUndefined();
    expect(res.json().data.metrics['service.consecutive_failures']).toBeUndefined();
  });
});
