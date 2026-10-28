import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { CoreError } from '../../core/errors';
import { credentialIdentity } from '../readScope';
import { sameRiskTerminal } from '../riskTerminal';
import { contracts, evaluateRisk, rules, scopeKey, visibleRiskChecks, type RiskScope, type RiskState } from '../../core/risk';
import { riskMeasurements, type RiskInputs, type RiskRead } from '../../../web/src/lib/riskSources';
import type { ReadEvidence } from '../../../web/src/api/client';
import type { ProducerScope } from './riskEvidence';

interface PreviousReport { scope?: RiskScope; producerScope?: ProducerScope; state: RiskState }

function previousReport(raw?: string): PreviousReport | null {
  if (!raw) return null;
  if (raw.length > 32768) throw new CoreError('Risk state is too large', 'validation');
  try {
    const value = JSON.parse(raw) as PreviousReport;
    if (!value || !value.state || typeof value.state !== 'object' || Array.isArray(value.state)) throw new Error();
    for (const [id, entry] of Object.entries(value.state)) {
      const rule = rules.find(r => r.id === id);
      if (!rule || !entry || !['OK', 'UNKNOWN', 'WARNING', 'CRITICAL', 'PAUSED'].includes(entry.status)
        || !Array.isArray(entry.criticalMetrics) || !entry.criticalMetrics.every(m => Boolean(contracts[m]))) throw new Error();
    }
    return value;
  } catch { throw new CoreError('Invalid prior Risk state', 'validation'); }
}

/** Read-only composition of existing GET routes, using the exact Risk page model. */
export function riskReportRoutes(_deps: AppDeps) {
  return async function plugin(app: FastifyInstance) {
    app.get('/risk/report', async (req, reply) => {
      const query = req.query as { address?: string; fresh?: string; previous?: string };
      const address = (query.address ?? process.env.BOROS_ROOT_ADDRESS)?.toLowerCase() ?? null;
      if (address !== null && !/^0x[0-9a-f]{40}$/.test(address)) throw new CoreError('Invalid Risk address', 'validation');
      const accountId = Number(process.env.BOROS_ACCOUNT_ID ?? 0);
      if (!Number.isInteger(accountId) || accountId < 0 || accountId > 255) throw new CoreError('Invalid Risk subaccount', 'validation');
      const previous = previousReport(query.previous);
      const scope: RiskScope = { credentialId: credentialIdentity(_deps), address, accountId, pool: 'account' };
      const metadata = new WeakMap<object, ReadEvidence>();
      const errors: Record<string, string> = {};
      const headers = { host: req.headers.host ?? 'localhost:6688', 'x-arb-token': req.headers['x-arb-token'] as string };
      const fresh = query.fresh === '1' ? 'fresh=1' : '';
      const read = async <T,>(name: string, url: string): Promise<RiskRead<T>> => {
        try {
          const response = await app.inject({ method: 'GET', url: `/api${url}`, headers });
          const envelope = response.json();
          if (response.statusCode !== 200 || envelope.ok !== true) throw new Error('Read failed');
          if (envelope.data !== null && typeof envelope.data === 'object') metadata.set(envelope.data, envelope.meta);
          if (envelope.meta?.stale || envelope.data?.stale) errors[name] = 'Stale source';
          return { data: envelope.data };
        } catch { errors[name] = 'Read failed'; return { isError: true }; }
      };
      // /risk/evidence verifies its producer against the account cache populated here.
      const account = await read<RiskInputs['account']['data']>('account', `/account?${fresh}`);
      const [positions, interest, collateral, asset, deals, orders, alerts, health, slices] = await Promise.all([
        read('positions', `/positions?${fresh}`), read('interest', `/account/interest?${fresh}`),
        address ? read('collateral', `/boros/collateral?address=${address}&${fresh}`) : Promise.resolve({ isError: true }),
        address ? read('asset', `/asset-view/${address}?${fresh}`) : Promise.resolve({ isError: true }),
        read('deals', '/deals?active=1'), read('orders', `/orders/open?${fresh}`),
        read('alerts', '/alerts?unacked=1'), read('health', '/health'),
        // Strategy slices prove intentional floating quantity (ticket 16).
        read('slices', '/slices'),
      ]);
      const supplement = await read('supplement', `/risk/evidence${address ? `?address=${address}` : ''}`);
      const inputs = { account, positions, interest, collateral, asset, supplement, deals, orders, alerts, health, slices } as RiskInputs;
      const evidenceFor = (data: unknown) => data !== null && typeof data === 'object' ? metadata.get(data) : undefined;
      const preliminary = riskMeasurements(scope, inputs, Date.now() / 1000, false, evidenceFor);
      const token = inputs.collateral.data?.tokens.find(t => t.tokenId === 2);
      const actualSize = preliminary.boros.length === 2 && preliminary.boros[0].sizeToken === preliminary.boros[1].sizeToken && token?.priceUsd
        ? preliminary.boros[0].sizeToken * token.priceUsd : 0;
      if (preliminary.days !== null && preliminary.days < 14 && actualSize > 0 && inputs.supplement.data?.baseline
        && scopeKey(inputs.supplement.data.scope) === scopeKey(scope)) {
        inputs.opportunities = await read('opportunities', `/opportunities?notionalUsd=${actualSize}&borosEntry=market&entryMode=both-market&exitMode=roll`);
      }
      const now = Date.now() / 1000;
      const adapted = riskMeasurements(scope, inputs, now, false, evidenceFor);
      const settings = inputs.supplement.data && scopeKey(inputs.supplement.data.scope) === scopeKey(scope) ? inputs.supplement.data.settings : undefined;
      const legacy = previous?.producerScope;
      const rawUser = (inputs.account.data as { userId?: unknown } | undefined)?.userId;
      const verifiedUser = (typeof rawUser === 'string' || typeof rawUser === 'number') && String(rawUser).trim()
        ? String(rawUser).trim() : null;
      const sameLegacy = legacy && legacy.root === address && legacy.account_id === accountId && legacy.base === 'ETH'
        && legacy.collateral_token_id === 2 && typeof legacy.gate_user_id === 'string' && legacy.gate_user_id.trim()
        && (verifiedUser === null || legacy.gate_user_id === verifiedUser)
        && sameRiskTerminal(legacy.terminal_url, `http://${headers.host}`);
      // Credential IDs rotate on a terminal restart. A verified stable Gate
      // user + wallet/subaccount identity preserves recovery state across it.
      const sameSubject = !previous?.scope || previous.scope.address === address
        && previous.scope.accountId === accountId && ['ETH-cross', 'account'].includes(previous.scope.pool);
      const sameCredential = previous?.scope && previous.scope.credentialId === scope.credentialId && sameSubject;
      const prior = previous && (sameCredential || previous.scope && scopeKey(previous.scope) === scopeKey(scope)
        || sameSubject && sameLegacy) ? previous.state : {};
      const report = evaluateRisk(scope, adapted.metrics, now, prior, adapted.pauseRollover, settings);
      const checks = visibleRiskChecks(report.checks);
      const complete = adapted.metrics['data.coverage_complete']?.value === true && Object.keys(errors).length === 0;
      // Version 2 carries the floating exemption the funding checks applied, so
      // the monitor's continuous-gap history uses the same quantities.
      return reply.ok({ version: 2, scope, observedAt: now, checks, state: report.state, errors, complete,
        configuration: inputs.supplement.data?.configuration,
        counts: Object.fromEntries(['CRITICAL', 'WARNING', 'UNKNOWN', 'OK', 'PAUSED'].map(s => [s, checks.filter(c => c.status === s).length])),
        collection: { account: inputs.account.data, agent: { root: address }, farm: inputs.asset.data, positions: inputs.positions.data,
          fundingApplicability: adapted.fundingApplicability },
        note: 'Same Risk page model and visible checks. UNKNOWN is not safe.' }, { observedAt: now * 1000, coverageComplete: complete });
    });
  };
}
