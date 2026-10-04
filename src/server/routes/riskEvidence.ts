import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { CoreError } from '../../core/errors';
import { resolveBorosFetch } from '../../core/boros/client';
import { readAgentApproval } from '../borosAgentApproval';
import { credentialIdentity } from '../readScope';
import { contracts, rules, type Condition, type MetricEvidence, type RiskScope, type RiskBaseline, type RiskSupplement } from '../../../web/src/lib/risk';

export interface ProducerScope {
  terminal_url: string; gate_user_id: string; root: string; account_id: number; base: string;
  collateral_token_id: number; config_id: string;
}
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function producerConfigId(config: RecordValue, root: string | null): string {
  const identity = { account_id: config.account_id ?? 0, base: config.base ?? 'ETH',
    collateral_token_id: config.collateral_token_id ?? 2, root: (typeof config.root === 'string' ? config.root : root)?.toLowerCase() ?? null,
    terminal_url: String(config.terminal_url ?? 'http://localhost:6688').replace(/\/$/, ''),
    recovery_margin_fraction: config.recovery_margin_fraction ?? .03, thresholds: config.thresholds ?? {} };
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
}
async function localJson(file: string): Promise<RecordValue> {
  try {
    if ((await stat(file)).size > 1024 * 1024) return {};
    return record(JSON.parse(await readFile(file, 'utf8')));
  } catch { return {}; }
}

/** Only local approved evidence and existing cached readers. No process or writes. */
export function riskEvidenceRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance) {
    app.get('/risk/evidence', async (req, reply) => {
      const address = (req.query as { address?: string }).address?.toLowerCase() ?? null;
      if (address !== null && !/^0x[0-9a-f]{40}$/.test(address)) throw new CoreError('Invalid Risk address', 'validation');
      const accountId = Number(process.env.BOROS_ACCOUNT_ID ?? 0);
      if (!Number.isInteger(accountId) || accountId < 0 || accountId > 255) throw new CoreError('Invalid Risk subaccount', 'validation');
      const scope: RiskScope = { credentialId: credentialIdentity(deps), address, accountId, pool: 'ETH-cross' };
      const metrics: Record<string, MetricEvidence> = {};
      const put = (id: string, value: unknown, observedAt: number | null, source: string, evidence: string,
        complete = true, ttlSeconds = contracts[id].max_age_seconds) => {
        metrics[id] = { value, observedAt, source, evidence, scope, complete, ttlSeconds, unit: contracts[id].unit };
      };
      const root = process.env.BOROS_ROOT_ADDRESS?.toLowerCase();
      const key = process.env.BOROS_AGENT_PRIVATE_KEY;
      if (address && address === root && key) {
        const approval = await readAgentApproval(resolveBorosFetch(deps.borosFetch), { root, accountId, agentPrivateKey: key });
        put('agent.approval', approval.state === 'unknown' ? null : approval.state,
          approval.observedAt ? approval.observedAt / 1000 : null, 'Boros chain approval (configured root/subaccount)', 'existing approval cache');
        put('agent.expiry_days', approval.expiry === null ? null : (approval.expiry - Date.now() / 1000) / 86400,
          approval.observedAt ? approval.observedAt / 1000 : null, 'Boros chain expiry', 'existing approval cache');
        const orders = deps.getBorosOrders?.();
        if (orders?.getGasBalance) {
          const gas = await deps.cache.get(`risk:gas:${root}`, 30_000, () => orders.getGasBalance!()).catch(() => null);
          if (gas) put('agent.gas_balance_usd', gas.value, gas.observedAt / 1000,
            'Boros root gas balance (separate from collateral)', 'existing getGasBalance reader', !gas.stale);
        }
      }
      const files = await deps.cache.get('risk:local-evidence', 30_000, async () => {
        const dir = path.join(deps.dataDir, 'risk-monitor');
        const [config, observations, state, heartbeat] = await Promise.all(
          ['config.json', 'observations.json', 'state.json', 'heartbeat.json'].map(f => localJson(path.join(dir, f))));
        return { config, observations, state, heartbeat };
      });
      const account = deps.cache.peek<{ userId?: unknown }>('account');
      const userId = account?.value.userId;
      const { config, observations, state, heartbeat } = files.value;
      const expectedId = producerConfigId(config, root ?? null);
      const matches = (v: unknown): boolean => {
        const s = record(v);
        return Boolean(userId !== undefined && userId !== null && String(userId) !== ''
          && s.gate_user_id === String(userId) && s.root === address && s.account_id === accountId
          && s.base === 'ETH' && s.collateral_token_id === 2
          && s.terminal_url === `http://${req.headers.host}`
          && typeof s.config_id === 'string' && s.config_id !== ''
          && s.config_id === expectedId && producerConfigId({ ...s,
            thresholds: config.thresholds ?? {}, recovery_margin_fraction: config.recovery_margin_fraction ?? .03 }, address) === expectedId);
      };
      for (const [id, raw] of Object.entries(record(observations.metrics))) {
        if (!contracts[id] || id.startsWith('notify.') || id.startsWith('service.') || id.startsWith('monitor.')) continue;
        const obs = record(raw);
        if (!matches(obs.scope)) continue;
        if (typeof obs.source !== 'string' || typeof obs.evidence !== 'string') continue;
        put(id, obs.value, finite(obs.observed_at) ? obs.observed_at : null, obs.source, obs.evidence,
          obs.coverage_complete === true, finite(obs.ttl_seconds) ? obs.ttl_seconds : 0);
        if (obs.unit !== contracts[id].unit) metrics[id].unit = String(obs.unit ?? '');
      }
      let baseline: RiskBaseline | null = null;
      const b = record(config.baseline);
      const quantitiesValid = (v: unknown): boolean => Object.keys(record(v)).length > 0 && Object.values(record(v)).every(finite);
      if (matches(b.scope) && quantitiesValid(b.boros) && quantitiesValid(b.perps) && finite(b.opened_at)
        && finite(b.observed_at) && b.observed_at <= Date.now() / 1000 && b.opened_at <= b.observed_at
        && typeof b.evidence === 'string' && b.evidence.trim()) baseline = b as unknown as RiskBaseline;
      const now = Date.now() / 1000;
      let fundingGapStartedAt: number | null = null;
      if (matches(state.producer_scope) && finite(state.observed_at) && state.observed_at <= now) {
        const observed = state.observed_at;
        put('service.consecutive_failures', state.service_failures, observed, 'Independent collector', 'scoped persistent collector state');
        const complete = state.last_complete_run_at;
        put('monitor.last_complete_run_at', complete, observed, 'Independent collector', 'last complete mandatory collection');
        put('service.last_success_age_s', finite(complete) && complete <= now ? now - complete : null,
          observed, 'Independent collector', 'producer last complete time');
        put('notify.pending_count', state.pending && typeof state.pending === 'object' && !Array.isArray(state.pending)
          ? Object.keys(state.pending as object).length : null, observed, 'Independent notification queue', 'scoped persistent queue count');
        put('notify.failure_streak', state.notify_failures, observed, 'Confirmed notification results', 'persistent failure counter');
        const confirmed = finite(state.notify_last_message_id) && state.notify_last_message_id > 0;
        put('notify.last_success_at', confirmed ? state.notify_last_success : null, observed,
          'Telegram confirmed message_id', 'producer confirmed delivery');
        if (now - observed <= 3600 && finite(state.uncovered_since) && state.uncovered_since <= observed) fundingGapStartedAt = state.uncovered_since;
      }
      if (matches(heartbeat.producer_scope) && finite(heartbeat.observedAt) && heartbeat.observedAt <= now) {
        put('monitor.heartbeat_age_s', now - heartbeat.observedAt, heartbeat.observedAt, 'Independent monitor producer', 'scoped producer heartbeat');
      }
      const result: RiskSupplement = { scope, metrics, baseline, fundingGapStartedAt,
        reason: 'Legacy/unscoped evidence is UNKNOWN. Collector completion and confirmed delivery are separate from terminal HTTP.' };
      if (matches(state.producer_scope) && finite(state.observed_at) && state.observed_at <= now && now - state.observed_at <= 3600) {
        const thresholds: Record<string, Condition[]> = {};
        for (const [id, conditions] of Object.entries(record(config.thresholds))) {
          const rule = rules.find(r => r.id === id);
          if (!rule || !Array.isArray(conditions) || !conditions.every(c => Array.isArray(c) && c.length === 4
            && rule.metrics.includes(c[0]) && ['lt', 'gt', 'abs_gt', 'eq', 'ne'].includes(c[1]) && ['WARNING', 'CRITICAL'].includes(c[3])
            && (contracts[c[0]].type === 'number' ? finite(c[2]) : contracts[c[0]].type === 'bool' ? typeof c[2] === 'boolean' : contracts[c[0]].values?.includes(c[2])))) continue;
          thresholds[id] = conditions as Condition[];
        }
        const recovery = config.recovery_margin_fraction ?? .03;
        result.settings = { thresholds, recoveryMarginFraction: finite(recovery) && recovery >= 0 && recovery <= 1 ? recovery : .03 };
      }
      return reply.ok(result);
    });
  };
}
