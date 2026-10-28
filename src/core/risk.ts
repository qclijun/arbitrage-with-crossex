import catalog from '../../scripts/risk-monitor-rules.json';
import metricContracts from '../../scripts/risk-monitor-metrics.json';

export type RiskStatus = 'OK' | 'UNKNOWN' | 'WARNING' | 'CRITICAL' | 'PAUSED';
export type Condition = [string, 'lt' | 'gt' | 'abs_gt' | 'eq' | 'ne', number | string | boolean, 'WARNING' | 'CRITICAL'];
export interface RiskRule {
  id: string; risk: number; label: string; metrics: string[]; sourcePlan: string;
  action: string; conditions: Condition[]; enabled?: boolean;
  account?: { label: string; metrics: string[]; conditions: Condition[]; action?: string };
}
export interface RiskScope {
  credentialId: string; address: string | null; accountId: number | null; pool: 'ETH-cross' | 'account';
}
export interface MetricContract {
  unit: string; type: string; max_age_seconds: number; source: string; values?: string[]; positive?: boolean;
}
export interface MetricEvidence {
  value: unknown; unit: string; source: string; evidence: string; observedAt: number | null;
  ttlSeconds: number; scope: RiskScope; complete: boolean; reason?: string; historicalValue?: unknown;
  lowerBound?: boolean;
  upperBound?: boolean;
  applicability?: 'NA';
  details?: Array<{ label: string; value: number | string | null; unit: string; reason?: string }>;
}
export interface RiskBorosPosition {
  marketAcc: string; marketId: number; venue: string | null; maturity: number | null;
  side: 'LONG' | 'SHORT'; sizeToken: number; entryApr: number | null; markApr: number | null;
  mtmUsd: number | null; notionalUsd: number | null; settleFeeApr: number | null;
  mtmUsdExact?: string | null; notionalUsdExact?: string | null;
  base?: string; tokenId?: number; sizeBase?: string | null;
  spreadVenues?: [string, string] | null;
}
export interface RiskAssetEvidence {
  address: string; accountId: number; observedAt: number | null; stale: boolean;
  positionsComplete: boolean; positions: RiskBorosPosition[];
  settlement: { netEth: number | null; complete: boolean; fromSec: number; throughSec: number; reason: string };
  version?: 2;
  settlements?: { complete: boolean; fromSec: number; throughSec: number; reason: string;
    pools: Array<{ marketAcc: string; tokenId: number; netToken: string }> };
}
export interface RiskBaseline {
  boros: Record<string, number>; perps: Record<string, number>; opened_at: number;
  observed_at: number; evidence: string;
}
export interface RiskSupplement {
  scope: RiskScope; metrics: Record<string, MetricEvidence>; baseline: RiskBaseline | null;
  fundingGapStartedAt: number | null; reason: string;
  fundingGapFingerprint?: string | null;
  fundingGapObservedAt?: number | null;
  fundingGapEth?: number | null;
  settings?: { thresholds: Record<string, Condition[]>; recoveryMarginFraction: number };
  configuration?: { configId: string; stateDir: string; observationsFile: string };
}
export interface CheckState { status: RiskStatus; criticalMetrics: string[] }
export type RiskState = Record<string, CheckState>;
export interface RiskCheck {
  id: string; label: string; risk: number; status: RiskStatus; metrics: Record<string, MetricEvidence>;
  thresholds: Condition[]; coverageComplete: boolean; reason: string; recommendedAction: string;
}
export const rules = catalog as RiskRule[];
export const contracts = metricContracts as Record<string, MetricContract>;
export const FUNDING_GAP_MIN_USD = 10;
/**
 * Boros rejects orders worth this much or less (`DEFAULT_MIN_ORDER_VALUE` in the
 * backend's trade.service), so a leg at this size can only settle.
 *
 * The BOUNDARY is rejected too, not just what is under it: the venue prices an
 * order with its own collateral quote, and a USDT quote a hair under $1 makes 10
 * units worth $9.998 — observed live, a 10-unit pair came back "Order value must
 * be greater than 10 USD". Treating exactly $10 as executable would leave a leg
 * we cannot roll, top up or close looking executable, which is precisely the
 * noise the dust exemption exists to remove.
 *
 * Single definition: `src/core/boros/pair.ts` imports this one so the confirm
 * blocker and the risk exemption can never disagree about the boundary.
 */
export const MIN_ORDER_VALUE_USD = 10;
/**
 * Dust is a leg whose own notional is at or below the minimum executable order
 * value: it cannot be rolled, topped up or closed on the venue, it only settles
 * at maturity. Unknown notional stays material — never hide a leg we cannot size.
 */
export function materialBorosLeg(leg: { notionalUsd?: number | null }): boolean {
  const notional = leg.notionalUsd;
  return !(typeof notional === 'number' && Number.isFinite(notional) && notional <= MIN_ORDER_VALUE_USD);
}
export function fundingQuantityVerified(ratio: number, unmatched: boolean, directionMatch: boolean,
  conditions = rules.find(r => r.id === 'hedge.hl_size_gap_eth')!.account!.conditions): boolean {
  return !unmatched && directionMatch && !conditions.some(([id, op, threshold]) =>
    id === 'hedge.funding_material_gap_ratio' && typeof threshold === 'number'
      && (op === 'gt' ? ratio > threshold : op === 'abs_gt' ? Math.abs(ratio) > threshold
        : op === 'lt' ? ratio < threshold : op === 'eq' ? ratio === threshold : ratio !== threshold));
}
export const severity: Record<RiskStatus, number> = { PAUSED: -1, OK: 0, UNKNOWN: 1, WARNING: 2, CRITICAL: 3 };
export function effectiveRiskRule(rule: RiskRule, scope: RiskScope): RiskRule {
  return scope.pool === 'account' && rule.account ? { ...rule, ...rule.account } : rule;
}
/** Checks currently displayed by Risk and used by the background notifier. */
export function visibleRiskChecks(checks: RiskCheck[]): RiskCheck[] {
  return checks.filter(check => check.risk !== 8
    && check.id !== 'hedge.market_identity_match' && check.id !== 'positions.unexpected_change_eth');
}
export function scopeKey(scope: RiskScope): string {
  return JSON.stringify([scope.credentialId, scope.address?.toLowerCase(), scope.accountId, scope.pool]);
}

/** Tagged IEEE-754 numbers avoid Python/JS JSON spelling differences (1.0, exponents). */
export function canonicalRiskIdentity(value: unknown): string {
  const encode = (v: unknown): unknown => {
    if (typeof v === 'number') {
      const bytes = new DataView(new ArrayBuffer(8));
      bytes.setFloat64(0, v === 0 ? 0 : v);
      return ['number', Array.from({ length: 8 }, (_, i) => bytes.getUint8(i).toString(16).padStart(2, '0')).join('')];
    }
    if (Array.isArray(v)) return ['array', v.map(encode)];
    if (v !== null && typeof v === 'object') return ['object', Object.keys(v).sort().map(k => [k, encode((v as Record<string, unknown>)[k])])];
    return [v === null ? 'null' : typeof v, v];
  };
  return JSON.stringify(encode(value));
}

/** Identity of one continuous funding gap. Proven floating quantity (ticket
 * 16) joins it only when there is some, so earlier histories keep theirs;
 * scripts/risk_monitor.py computes the same identity. */
export function fundingGapFingerprint(perps: { symbol: string; exchange: string; side: string; qty: number }[], boros: RiskBorosPosition[],
  scope: RiskScope, floating: Array<{ symbol: string; side: string; qty: string }> = []): string {
  return canonicalRiskIdentity({ root: scope.address?.toLowerCase(), account_id: scope.accountId,
    perps: perps.map(p => [p.symbol, p.exchange, p.side, p.qty]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1),
    boros: boros.map(b => [b.marketId, b.venue, b.side, b.sizeToken, b.maturity]).sort((a, b) => Number(a[0]) - Number(b[0])),
    ...(floating.length ? { floating: floating.map(f => [f.symbol, f.side, Number(f.qty)])
      .sort((a, b) => a[0] !== b[0] ? (String(a[0]) < String(b[0]) ? -1 : 1) : String(a[1]) < String(b[1]) ? -1 : 1) } : {}) });
}
export function validMetric(value: unknown, contract: MetricContract): boolean {
  if (contract.type === 'bool') return typeof value === 'boolean';
  if (contract.type === 'enum') return typeof value === 'string' && Boolean(contract.values?.includes(value));
  return typeof value === 'number' && Number.isFinite(value)
    && (!contract.positive || value > 0)
    && (contract.unit !== 'count' || (value >= 0 && Number.isInteger(value)));
}
export function validateEvidence(id: string, entry: MetricEvidence, scope: RiskScope, now: number): string | null {
  const contract = contracts[id];
  const na = (id === 'boros.buffer_runway_days' || ['rollover.days_to_maturity', 'rollover.next_net_apr', 'rollover.depth_coverage_ratio',
    'rollover.atomic_batch_ready', 'rollover.atomic_margin_need_usd', 'rollover.atomic_available_after_usd',
    'rollover.atomic_margin_shortfall_usd', 'rollover.execution_admission', 'rollover.full_batch_ready', 'rollover.batch_size_eth'].includes(id))
    && entry.applicability === 'NA' && entry.value === null;
  if (!contract || (!na && !validMetric(entry.value, contract))) return entry.reason ?? 'Invalid or missing value / type';
  if (entry.unit !== contract.unit) return 'Wrong contract unit';
  if (scopeKey(entry.scope) !== scopeKey(scope) || !scope.credentialId) return 'Account / wallet / subaccount scope not verified';
  if (!entry.source?.trim() || !entry.evidence?.trim()) return 'Missing source / evidence reference';
  if (typeof entry.observedAt !== 'number' || !Number.isFinite(entry.observedAt)
      || !Number.isFinite(entry.ttlSeconds) || entry.ttlSeconds <= 0) return 'Missing producer observation time / TTL';
  const age = now - entry.observedAt;
  if (age < 0 || (contract.unit === 'unix seconds' && (entry.value as number) > now)) return 'Future evidence';
  if (age > Math.min(entry.ttlSeconds, contract.max_age_seconds)) return 'Expired evidence (historical value only)';
  if (!entry.complete) return entry.reason ?? 'Incomplete coverage';
  return null;
}

/** Display state only: never touches collector or notification state. */
export function evaluateRisk(scope: RiskScope, measurements: Record<string, MetricEvidence>, now: number,
  previous: RiskState = {}, pauseRollover = false, settings?: RiskSupplement['settings']) {
  const state: RiskState = {};
  const checks: RiskCheck[] = rules.filter(r => r.enabled !== false).map(original => {
    const rule = effectiveRiskRule(original, scope);
    const metrics: Record<string, MetricEvidence> = {};
    for (const id of rule.metrics) {
      const entry = measurements[id] ?? { value: null, unit: contracts[id].unit, source: contracts[id].source,
        evidence: '', observedAt: null, ttlSeconds: contracts[id].max_age_seconds, scope, complete: false,
        reason: 'Missing verified evidence: ' + contracts[id].source };
      const error = validateEvidence(id, entry, scope, now);
      const usableBound = (entry.lowerBound || entry.upperBound) && !entry.complete && error === 'Incomplete coverage' && typeof entry.value === 'number';
      metrics[id] = error ? { ...entry, value: usableBound ? entry.value : null, complete: false, reason: error,
        historicalValue: entry.historicalValue ?? entry.value } : entry;
    }
    const configured = settings?.thresholds[rule.id];
    // Legacy combinations use different denominators/units; never reinterpret them.
    const fundingRule = scope.pool === 'account' && rule.id === 'hedge.hl_size_gap_eth';
    const compatible = configured?.length && configured.every(c => rule.metrics.includes(c[0])
      && (!fundingRule || !['hedge.hl_size_gap_eth', 'hedge.binance_size_gap_eth', 'hedge.quantity_verified'].includes(c[0])));
    const activeThresholds = compatible ? [...configured] : rule.conditions;
    if (fundingRule && compatible) {
      for (const condition of rule.conditions.filter(c => ['hedge.direction_match', 'hedge.funding_unmatched'].includes(c[0]))) {
        activeThresholds.push(condition);
      }
    }
    const missing = rule.metrics.filter(id => (!metrics[id].applicability && metrics[id].value === null) || !metrics[id].complete);
    const old = previous[rule.id];
    let status: RiskStatus = missing.length ? 'UNKNOWN' : 'OK';
    const reasons = missing.map(id => `${id}: ${metrics[id].reason}`);
    const criticalMetrics: string[] = [];
    const thresholds = activeThresholds;
    let fundingMismatch = false;
    for (const [id, op, threshold, level] of thresholds) {
      const value = metrics[id]?.value;
      if (value === null || value === undefined) continue;
      if (metrics[id].lowerBound && !metrics[id].complete && !['gt', 'abs_gt'].includes(op)) continue;
      if (metrics[id].upperBound && !metrics[id].complete && op !== 'lt') continue;
      const hit = op === 'eq' ? value === threshold : op === 'ne' ? value !== threshold
          : typeof value === 'number' && typeof threshold === 'number'
            && (op === 'lt' ? value < threshold : op === 'gt' ? value > threshold : Math.abs(value) > threshold);
      if (hit) {
        fundingMismatch = true;
        if (severity[level] > severity[status]) status = level;
        // Alert text must carry the observed value: a bare "gt 0" hides whether
        // the wallet borrow is a transient $5 flap or a real funding problem.
        // Non-numeric values (bool / enum) keep their literal form.
        const unit = contracts[id]?.unit ?? '';
        const shown = typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value;
        reasons.push(`${id} ${op} ${threshold}（当前 ${shown}${unit ? ' ' + unit : ''}）`);
        if (level === 'CRITICAL') criticalMetrics.push(id);
      }
    }
    if (fundingRule && metrics['hedge.quantity_verified']?.complete) {
      metrics['hedge.quantity_verified'] = { ...metrics['hedge.quantity_verified'], value: !fundingMismatch };
    }
    const unresolved = old?.criticalMetrics.filter(id => !rule.metrics.includes(id) || (!metrics[id]?.applicability && metrics[id]?.value === null) || !metrics[id]?.complete) ?? [];
    if (unresolved.length) { status = 'CRITICAL'; reasons.push('Previous CRITICAL cannot be verified: ' + unresolved.join(', ')); }
    state[rule.id] = { status, criticalMetrics: [...new Set([...criticalMetrics, ...unresolved])] };
    // Pausing never clears previously known danger or its recovery state.
    if (pauseRollover && rule.id.startsWith('rollover.') && rule.id !== 'rollover.days_to_maturity'
        && severity[status] < severity.WARNING) {
      status = 'PAUSED'; reasons.push('Complete current positions prove maturity at least 14 days away');
      if (old) state[rule.id] = old;
    }
    if (rule.id === 'custody.incident_status' || rule.id === 'protocol.incident_status') reasons.push('Fresh review only; not proof of safety');
    return { id: rule.id, label: rule.label, risk: rule.risk, status, metrics, thresholds,
      coverageComplete: missing.length === 0, reason: reasons.join('; '), recommendedAction: rule.action };
  });
  checks.sort((a, b) => severity[b.status] - severity[a.status] || a.risk - b.risk);
  return { checks, state };
}
