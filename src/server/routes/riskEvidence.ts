import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { CoreError } from '../../core/errors';
import { resolveBorosFetch } from '../../core/boros/client';
import { readAgentApproval } from '../borosAgentApproval';
import { credentialIdentity } from '../readScope';
import { sameRiskTerminal } from '../riskTerminal';
import { canonicalRiskIdentity, contracts, rules, validMetric, type Condition, type MetricEvidence, type RiskScope, type RiskBaseline, type RiskSupplement } from '../../core/risk';

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
  return createHash('sha256').update(canonicalRiskIdentity(identity)).digest('hex');
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
      const scope: RiskScope = { credentialId: credentialIdentity(deps), address, accountId, pool: 'account' };
      const metrics: Record<string, MetricEvidence> = {};
      const put = (id: string, value: unknown, observedAt: number | null, source: string, evidence: string,
        complete = true, ttlSeconds = contracts[id].max_age_seconds) => {
        metrics[id] = { value: validMetric(value, contracts[id]) ? value : null, observedAt, source, evidence, scope, complete, ttlSeconds, unit: contracts[id].unit };
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
          && sameRiskTerminal(s.terminal_url, `http://${req.headers.host}`)
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
        if (obs.unit !== undefined && obs.unit !== contracts[id].unit) metrics[id].unit = String(obs.unit);
      }
      let baseline: RiskBaseline | null = null;
      const b = record(config.baseline);
      const borosEntries = Object.entries(record(b.boros));
      const perpEntries = Object.entries(record(b.perps));
      const quantitiesValid = borosEntries.length === 2 && borosEntries.every(([id, qty]) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && finite(qty) && qty !== 0)
        && borosEntries.filter(([, qty]) => (qty as number) < 0).length === 1
        && perpEntries.length === 2 && ['HYPERLIQUID', 'BINANCE'].every(venue => {
          const entries = perpEntries.filter(([symbol]) => new RegExp(`^${venue}_FUTURE_ETH_(USDT|USDC|USD)$`).test(symbol));
          return entries.length === 1 && finite(entries[0][1]) && (venue === 'HYPERLIQUID' ? entries[0][1] < 0 : entries[0][1] > 0);
        });
      if (matches(b.scope) && quantitiesValid && finite(b.opened_at) && b.opened_at > 0
        && finite(b.observed_at) && b.observed_at <= Date.now() / 1000 && b.opened_at <= b.observed_at
        && typeof b.evidence === 'string' && b.evidence.trim()) baseline = {
          boros: record(b.boros) as Record<string, number>, perps: record(b.perps) as Record<string, number>,
          opened_at: b.opened_at, observed_at: b.observed_at, evidence: b.evidence,
        };
      const now = Date.now() / 1000;
      let fundingGapStartedAt: number | null = null;
      let fundingGapIdentity: string | null = null;
      let fundingGapObservedAt: number | null = null;
      let fundingGapEth: number | null = null;
      if (matches(state.producer_scope) && finite(state.observed_at) && state.observed_at <= now) {
        const observed = state.observed_at;
        put('service.consecutive_failures', state.service_failures, observed, 'Independent collector', 'scoped persistent collector state');
        const complete = state.last_complete_run_at;
        put('monitor.last_complete_run_at', complete, finite(complete) ? complete : null, 'Independent collector', 'last complete mandatory collection');
        put('service.last_success_age_s', finite(complete) && complete <= now ? now - complete : null,
          observed, 'Independent collector', 'producer last complete time');
        put('notify.pending_count', state.pending && typeof state.pending === 'object' && !Array.isArray(state.pending)
          ? Object.keys(state.pending as object).length : null, observed, 'Independent notification queue', 'scoped persistent queue count');
        put('notify.failure_streak', state.notify_failures, observed, 'Confirmed notification results', 'persistent failure counter');
        const confirmed = finite(state.notify_last_message_id) && Number.isInteger(state.notify_last_message_id) && state.notify_last_message_id > 0
          && finite(state.notify_last_success) && state.notify_last_success > 0 && state.notify_last_success <= observed;
        // Re-observe persisted delivery history alongside the current queue/failures.
        // The value remains the real send time; this is not a current channel probe.
        put('notify.last_success_at', confirmed ? state.notify_last_success : null, confirmed ? observed : null,
          'Persisted Telegram confirmed delivery history (not a current channel probe)', 'producer message_id and original send time');
        const gap = record(state.funding_gap);
        if (now - observed <= 3600 && finite(gap.observed_at) && gap.observed_at === observed
          && finite(gap.started_at) && gap.started_at > 0 && gap.started_at <= observed && typeof gap.fingerprint === 'string'
          && finite(gap.uncovered_eth) && gap.uncovered_eth > 0) {
          fundingGapStartedAt = gap.started_at;
          fundingGapIdentity = gap.fingerprint;
          fundingGapObservedAt = gap.observed_at;
          fundingGapEth = gap.uncovered_eth;
        }
      }
      if (matches(heartbeat.producer_scope) && finite(heartbeat.observedAt) && heartbeat.observedAt <= now) {
        put('monitor.heartbeat_age_s', now - heartbeat.observedAt, heartbeat.observedAt, 'Independent monitor producer', 'scoped producer heartbeat');
      }
      const result: RiskSupplement = { scope, metrics, baseline, fundingGapStartedAt, fundingGapFingerprint: fundingGapIdentity, fundingGapObservedAt, fundingGapEth,
        reason: 'Legacy/unscoped evidence is UNKNOWN. Collector completion and confirmed delivery are separate from terminal HTTP.' };
      // Management settings are local configuration, not collector liveness.
      // Apply them on the first run too, while keeping runtime evidence scoped.
      const configuredRoot = typeof config.root === 'string' ? config.root.toLowerCase() : root ?? address;
      if (configuredRoot === address && (config.account_id ?? 0) === accountId
        && (config.base ?? 'ETH') === 'ETH' && (config.collateral_token_id ?? 2) === 2
        && sameRiskTerminal(config.terminal_url ?? `http://${req.headers.host}`, `http://${req.headers.host}`)) {
        const thresholds: Record<string, Condition[]> = {};
        for (const [id, conditions] of Object.entries(record(config.thresholds))) {
          const rule = rules.find(r => r.id === id);
          if (!rule || !Array.isArray(conditions) || !conditions.every(c => Array.isArray(c) && c.length === 4
            && [...rule.metrics, ...(rule.account?.metrics ?? [])].includes(c[0]) && ['lt', 'gt', 'abs_gt', 'eq', 'ne'].includes(c[1]) && ['WARNING', 'CRITICAL'].includes(c[3])
            && (contracts[c[0]].type === 'number' ? finite(c[2]) : contracts[c[0]].type === 'bool' ? typeof c[2] === 'boolean' : contracts[c[0]].values?.includes(c[2])))) continue;
          thresholds[id] = conditions as Condition[];
        }
        const recovery = config.recovery_margin_fraction ?? .03;
        result.settings = { thresholds, recoveryMarginFraction: finite(recovery) && recovery >= 0 && recovery <= 1 ? recovery : .03 };
      }
      result.configuration = {
        configId: producerConfigId({ ...config, thresholds: result.settings?.thresholds ?? {},
          recovery_margin_fraction: result.settings?.recoveryMarginFraction ?? .03 }, root ?? address),
        stateDir: path.resolve(deps.dataDir, 'risk-monitor'),
        observationsFile: path.resolve(deps.dataDir, 'risk-monitor', 'observations.json'),
      };
      return reply.ok(result);
    });
  };
}
