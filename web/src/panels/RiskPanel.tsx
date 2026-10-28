import { useRef } from 'react';
import { useAccount, useAccountInterest, useActiveDeals, useAlerts, useAssetView, useBorosCollateral, useCredentials, useOpenOrders, useOpportunities, usePositions, useRiskEvidence, useTerminalHealth } from '../api/queries';
import { useTabActive } from '../components/TabBar';
import { contracts, evaluateRisk, formatRiskTime, formatRiskValue, scopeKey, validateEvidence, visibleRiskChecks, type MetricEvidence, type RiskScope, type RiskState, type RiskStatus } from '../lib/risk';
import { riskMeasurements } from '../lib/riskSources';
import { useTrackedAddress } from './trackedAddress';
import { useStrategySlices } from '../api/sliceQueries';

const tones: Record<RiskStatus, string> = { CRITICAL: 'text-negative', WARNING: 'text-warning', UNKNOWN: 'text-ink-400', OK: 'text-positive', PAUSED: 'text-ink-500' };
const featured = ['gate.equity_usd', 'gate.upnl_usd', 'gate.loss_equity_ratio', 'boros.equity_usd', 'boros.rate_mtm_usd',
  'boros.mtm_loss_equity_ratio', 'hedge.perp_net_eth', 'hedge.perp_net_btc', 'hedge.residual_equity_ratio',
  'hedge.funding_gap_ratio', 'hedge.funding_gap_usd', 'boros.settlement_net_24h_usd', 'boros.buffer_runway_days', 'rollover.days_to_maturity',
  'rollover.next_net_apr', 'rollover.depth_coverage_ratio', 'rollover.full_batch_ready', 'rollover.atomic_batch_ready',
  'rollover.roll_path', 'rollover.execution_admission', 'rollover.batch_size_eth', 'rollover.remaining_eth', 'rollover.rolled_eth', 'rollover.atomic_available_after_usd'];

export function RiskPanel() {
  const { address } = useTrackedAddress();
  const credentials = useCredentials();
  const account = useAccount();
  const positions = usePositions();
  const interest = useAccountInterest();
  const collateral = useBorosCollateral(address);
  // Risk uses complete history, independent of the Positions display window.
  const asset = useAssetView(address);
  const scope: RiskScope = { credentialId: credentials.data?.identity ?? '', address: address?.toLowerCase() ?? null,
    accountId: collateral.data && collateral.data.address.toLowerCase() === address?.toLowerCase() ? collateral.data.accountId : 0,
    pool: 'account' };
  const supplement = useRiskEvidence(scope);
  const deals = useActiveDeals();
  const orders = useOpenOrders();
  const alerts = useAlerts();
  const health = useTerminalHealth();
  const slices = useStrategySlices();
  const shown = useTabActive();
  const now = Date.now() / 1000;
  const inputs = { account, positions, interest, collateral, asset, supplement, deals, orders, alerts, health, slices };
  const preliminary = riskMeasurements(scope, inputs, now);
  const token = collateral.data?.tokens.find(t => t.tokenId === 2);
  const actualSize = preliminary.boros.length === 2 && preliminary.boros[0].sizeToken === preliminary.boros[1].sizeToken && token?.priceUsd
    ? preliminary.boros[0].sizeToken * token.priceUsd : 0;
  const opportunities = useOpportunities({ notionalUsd: actualSize, borosEntry: 'market', entryMode: 'both-market', exitMode: 'roll' },
    shown && preliminary.days !== null && preliminary.days < 14 && actualSize > 0 && Boolean(supplement.data?.baseline && scopeKey(supplement.data.scope) === scopeKey(scope)));
  const adapted = riskMeasurements(scope, { ...inputs, opportunities }, now);
  const local = useRef<{ key: string; state: RiskState; history: Record<string, MetricEvidence> }>({ key: '', state: {}, history: {} });
  const key = scopeKey(scope);
  if (local.current.key !== key) local.current = { key, state: {}, history: {} };
  for (const [id, metric] of Object.entries(adapted.metrics)) {
    if (!validateEvidence(id, metric, scope, now)) local.current.history[id] = metric;
    else if (local.current.history[id]) adapted.metrics[id] = { ...metric, historicalValue: local.current.history[id].value };
  }
  const settings = !supplement.isError && supplement.data && scopeKey(supplement.data.scope) === key ? supplement.data.settings : undefined;
  const report = evaluateRisk(scope, adapted.metrics, now, local.current.state, adapted.pauseRollover, settings);
  local.current.state = report.state;
  // Category 8 is temporarily omitted from the Risk page; its contracts remain documented.
  // Historical identity and quantity-change checks are temporarily hidden, including summary counts.
  // Keep their calculations and rules for later restoration; do not auto-accept a baseline.
  const checks = visibleRiskChecks(report.checks);
  const counts = (['CRITICAL', 'WARNING', 'UNKNOWN', 'OK', 'PAUSED'] as const).map(status => ({ status,
    count: checks.filter(c => c.status === status).length }));
  const failed = Object.values(inputs).some(q => q.isError);
  const loading = account.isPending || (Boolean(address) && collateral.isPending);
  return <section aria-label="Risk inspection" className="space-y-5">
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-5">
      <h2 className="text-lg font-semibold text-ink-50">Risk</h2>
      <p className="mt-2 text-sm text-ink-400">Gate CrossEx account · {credentials.data?.keyMasked ?? 'UNKNOWN'} · ETH / BTC</p>
      <p className="num mt-1 break-all text-xs text-ink-500">Boros wallet · {scope.address ?? 'UNKNOWN — select a wallet in Settings'} · Subaccount {scope.accountId ?? 'UNKNOWN'}</p>
      <p className="mt-3 text-xs text-ink-500">Management thresholds and conditional models. UNKNOWN is not safe. Terminal HTTP, independent collection and confirmed notification delivery are separate.</p>
      <p role="status" className="mt-3 text-sm text-ink-400">{loading ? 'Loading verified evidence — unavailable checks are UNKNOWN.' : failed ? 'Read failed — last successful values are historical. Known CRITICAL remains until verified recovery.' : 'Shared terminal refresh; source observation times and coverage appear in each check.'}</p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="Risk severity counts">
        {counts.map(({ status, count }) => <div key={status} className="rounded border border-ink-700 p-3"><span className={`text-xs font-medium ${tones[status]}`}>{status}</span><p className="num mt-1 text-2xl text-ink-50">{count}</p></div>)}
      </div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Key risk values">
      {featured.map(id => {
        const metric = checks.flatMap(c => Object.entries(c.metrics)).find(([k]) => k === id)?.[1];
        return <div key={id} className="rounded-lg border border-ink-700 bg-ink-900 p-4"><p className="text-xs text-ink-400">{id}</p><p className="num mt-2 break-words text-lg text-ink-50">{id === 'hedge.funding_gap_ratio' && typeof metric?.value === 'number'
          ? `${(metric.value * 100).toFixed(4)}%` : <>{metric?.applicability === 'NA' ? 'NA' : formatRiskValue(metric?.value, contracts[id].unit)} <span className="text-xs text-ink-500">{contracts[id].unit}</span></>}</p></div>;
      })}
    </div>
    <div className="space-y-3" aria-label="All enabled risk checks">
      {checks.map(check => <details key={check.id} className="rounded-lg border border-ink-700 bg-ink-900 p-4" open={check.status === 'CRITICAL' || check.id === 'rollover.next_net_apr' || check.id === 'rollover.incremental_margin_usd'}>
        <summary className="cursor-pointer text-sm text-ink-200"><span className={`mr-3 font-semibold ${tones[check.status]}`}>{check.status}</span>{check.label}<span className="ml-3 text-xs text-ink-500">{check.id} · {check.coverageComplete ? 'Complete applicable evidence' : 'Incomplete / unknown evidence'}</span></summary>
        <div className="mt-4 space-y-4">
          {Object.entries(check.metrics).map(([id, e]) => <div key={id} className="border-t border-ink-700 pt-3 text-xs text-ink-400">
            <p className="break-words"><span className="text-ink-200">{id}</span> · <span className="num text-ink-50">{e.lowerBound && e.value !== null ? '≥ ' : e.upperBound && e.value !== null ? '≤ ' : ''}{e.applicability === 'NA' ? 'NA' : formatRiskValue(e.value, e.unit)} {e.unit}</span></p>
            {e.details?.map((d, i) => <p key={i} className="mt-1 break-words">{d.label}: {typeof d.value === 'string' ? d.value : formatRiskValue(d.value, d.unit)} {d.unit}{d.reason ? ' · ' + d.reason : ''}</p>)}
            {e.value === null && e.historicalValue !== null && e.historicalValue !== undefined && <p className="mt-1 text-warning">Historical last success: {formatRiskValue(e.historicalValue, e.unit)} {e.unit} — not current evidence</p>}
            <p className="mt-1">Thresholds: {check.thresholds.filter(c => c[0] === id).map(([, op, threshold, status]) => `${status} ${op} ${threshold} ${e.unit}`).join('; ') || 'Required associated evidence'}</p>
            <p className="mt-1 break-words">Source: {e.source}</p>
            <p className="mt-1 break-words">Evidence: {e.evidence || 'UNKNOWN'}</p>
            <p className="mt-1">Observed: {formatRiskTime(e.observedAt)} · Age: {e.observedAt === null || !Number.isFinite(e.observedAt) ? 'UNKNOWN' : formatRiskValue(now - e.observedAt, 'seconds')} s · TTL: {Number.isFinite(e.ttlSeconds) ? Math.min(e.ttlSeconds, contracts[id].max_age_seconds) : 'UNKNOWN'} s · {e.complete ? 'Complete' : 'Incomplete'}</p>
            {e.reason && <p className="mt-1">{e.reason}</p>}
          </div>)}
          <p className="break-words text-xs text-ink-400">{check.reason || 'No configured condition triggered; valid evidence only.'}</p>
          <p className="text-sm text-ink-200">Suggested review: {check.recommendedAction}</p>
        </div>
      </details>)}
    </div>
  </section>;
}
