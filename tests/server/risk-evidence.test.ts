import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/server/cache';
import { producerConfigId } from '../../src/server/routes/riskEvidence';
import { HOST, makeTestApp } from './helpers/gate-nock';
const root = '0x' + 'ab'.repeat(20), other = '0x' + 'cd'.repeat(20);
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });
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
  return { now, folder, scope, config, state };
}
describe('scoped read-only Risk evidence API', () => {
  it('separates fresh heartbeat, old complete collection and confirmed delivery without exposing or modifying files', async () => {
    const f = await fixture();
    const before = ['state.json', 'heartbeat.json', 'config.json', 'observations.json'].map(file => readFileSync(path.join(f.folder, file), 'utf8'));
    const res = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${root}`, headers: HOST });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.metrics['monitor.heartbeat_age_s'].value).toBeGreaterThanOrEqual(10);
    expect(data.metrics['service.last_success_age_s'].value).toBeGreaterThanOrEqual(1000);
    expect(data.metrics['notify.pending_count'].value).toBe(1);
    expect(data.metrics['notify.failure_streak'].value).toBe(3);
    expect(data.metrics['notify.last_success_at'].value).toBe(f.now - 50);
    expect(data.metrics['stablecoin.usdt_usd']).toMatchObject({ value: .97, ttlSeconds: 100, unit: 'USD' });
    expect(res.body).not.toContain('do-not-return');
    expect(['state.json', 'heartbeat.json', 'config.json', 'observations.json'].map(file => readFileSync(path.join(f.folder, file), 'utf8'))).toEqual(before);
    const foreign = await app!.inject({ method: 'GET', url: `/api/risk/evidence?address=${other}`, headers: HOST });
    expect(foreign.json().data.metrics).toEqual({});
    expect(foreign.json().data.baseline).toBeNull();
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
});
