import { open } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app';
import { sameRiskTerminal } from './riskTerminal';
import { contracts, type MetricEvidence, type RiskScope } from '../core/risk';
import type { AssetViewResponse } from '../../web/src/api/types';

import { rolloverWatchProfile as profile, watchProgress, watchPreview, watchRequest, nextWatchProbe,
  watchFinite as finite, sameWatchSize, type WatchSimulation } from '../core/rolloverWatch';

export const WATCH_ADDRESS = profile.address;
const SIZE = profile.totalSize;
const ids = ['rollover.next_net_apr', 'rollover.depth_coverage_ratio', 'rollover.atomic_batch_ready',
  'rollover.atomic_margin_need_usd', 'rollover.atomic_available_after_usd', 'rollover.atomic_margin_shortfall_usd',
  'rollover.execution_admission', 'rollover.full_batch_ready', 'rollover.batch_size_eth', 'rollover.remaining_eth', 'rollover.rolled_eth', 'rollover.roll_path'];
type Detail = NonNullable<MetricEvidence['details']>[number];

/** Only a bounded tail of the daily ledger; never writes or runs the collector. */
async function dailyDetails(dataDir: string, now: number, remaining: number, quoteSize: number): Promise<Detail[]> {
  const file = await open(path.join(dataDir, 'risk-monitor', 'rollover-watch.jsonl'), 'r').catch(() => null);
  if (!file) return [{ label: 'Daily v3 watch', value: 'UNKNOWN — run scripts/rollover_watch.py', unit: '' }];
  try {
    const size = (await file.stat()).size, start = Math.max(0, size - 65536);
    const buffer = Buffer.alloc(Math.min(size, 65536));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.v !== 3 || !finite(row.now_unix) || row.now_unix > now) continue;
      const subject = row.watch_scope;
      if (subject?.address !== WATCH_ADDRESS || subject.account_id !== 0 || subject.size !== SIZE
        || !sameRiskTerminal(subject.terminal, 'http://localhost:6688') || !finite(row.sample_count) || row.sample_count < 3
        || !finite(row.sample_interval_seconds) || row.sample_interval_seconds < 60) continue;
      if (!sameWatchSize(row.quote_size_eth, quoteSize) || !sameWatchSize(row.remaining_eth, remaining)) continue;
      const historical = now - row.now_unix > 3600;
      return [
        { label: 'Daily v3 watch snapshot', value: `${row.ts} · ${historical ? 'HISTORICAL' : 'recorded sample'} · separate from live simulation`, unit: '' },
        { label: 'Daily economics basis', value: 'S/E are raw APR; S_r_star/M are risk-adjusted. R_B is subjective, not paid. A_usd deducts trade + settlement only; all-in profit remains UNKNOWN.', unit: '' },
        ...['S', 'E', 'S_r_star', 'S_r_star_cash', 'S_cons', 'M', 'M_cash', 'X_max'].map(key => ({ label: `Daily ${key}`, value: historical ? null : finite(row[key]) ? row[key] : null, unit: 'APR fraction' })),
        ...['A_usd', 'fee_A', 'fee_B', 'settlement_A_usd', 'settlement_B_usd', 'R_B', 'B_minus_A_ref_usd',
          'A_minus_B_cash_ref_usd', 'A_minus_B_risk_adjusted_ref_usd'].map(key => ({ label: `Daily ${key}`, value: historical ? null : finite(row[key]) ? row[key] : null, unit: 'USD' })),
        { label: 'Daily fees', value: typeof row.fee_source === 'string' ? row.fee_source : 'UNKNOWN', unit: '' },
        { label: 'Daily warnings', value: Array.isArray(row.warns) ? row.warns.filter((v: unknown) => typeof v === 'string').join('; ') : 'UNKNOWN', unit: '' },
      ];
    }
    return [{ label: 'Daily v3 watch', value: 'UNKNOWN — no valid v3 record; v1/v2 fee and profit semantics are incompatible', unit: '' }];
  } finally { await file.close(); }
}

/** Read-only composition: the only POST is the explicitly allowed batch preview.
 * No execute, signing, authorization, gas top-up or notification path is reachable.
 */
export async function rolloverEvidence(app: FastifyInstance, deps: AppDeps, scope: RiskScope,
  headers: Record<string, string>): Promise<Record<string, MetricEvidence>> {
  if (scope.address !== WATCH_ADDRESS || scope.accountId !== 0
    || process.env.BOROS_ROOT_ADDRESS?.toLowerCase() !== WATCH_ADDRESS) return {};
  const source = 'docs/rollover_watch.md · 196/198 → 209/213 · 3.9888313 ETH · POST /api/boros/roll/simulate (read-only)';
  const metrics: Record<string, MetricEvidence> = {};
  const put = (id: string, value: unknown, observedAt: number | null, details?: Detail[], reason?: string) => {
    metrics[id] = { value, observedAt, details, source, evidence: source, scope, complete: value !== null,
      unit: contracts[id].unit, ttlSeconds: 120, reason: value === null ? reason ?? 'Missing verified batch evidence' : undefined };
  };
  for (const id of ids) put(id, null, null);
  try {
    const read = async (url: string, payload?: unknown) => {
      const response = await app.inject({ method: payload ? 'POST' : 'GET', url: '/api' + url, headers,
        ...(payload ? { payload } : {}) });
      const body = response.json();
      // These routes timestamp their upstream snapshots in the payload,
      // rather than in reader metadata. Never use response meta.ts.
      const time = payload ? body.data?.simulatedAtMs : body.data?.risk?.observedAt;
      if (response.statusCode !== 200 || body.ok !== true || body.meta?.stale || body.data?.stale
        || body.meta?.credentialId !== scope.credentialId || !finite(time)
        || time > Date.now() || Date.now() - time > 120000) throw new Error('Read failed, stale or unscoped source');
      return body.data;
    };
    const asset = await read(`/asset-view/${scope.address}`) as AssetViewResponse;
    const risk = asset.risk;
    if (!risk || risk.address.toLowerCase() !== scope.address || risk.accountId !== scope.accountId
      || risk.version !== 2 || !risk.positionsComplete || risk.stale || !finite(risk.observedAt)
      || risk.observedAt > Date.now() || Date.now() - risk.observedAt > 120000) throw new Error('Incomplete current positions');
    const progress = watchProgress(risk.positions);
    put('rollover.execution_admission', 'UNKNOWN', risk.observedAt / 1000, [{ label: 'Missing admission evidence', value: 'Per-batch cost, cumulative budget, income review, approved deadline, operator attendance and prior receipt must be verified independently; this monitor never authorizes execution.', unit: '' }]);
    const now = Date.now() / 1000;
    put('rollover.remaining_eth', progress.remaining, risk.observedAt / 1000);
    put('rollover.rolled_eth', progress.rolled, risk.observedAt / 1000);
    if (progress.remaining === 0) {
      put('rollover.roll_path', 'DONE', risk.observedAt / 1000, [{ label: 'Progress', value: progress.state, unit: '' }]);
      for (const id of ids.filter(id => !['rollover.roll_path', 'rollover.remaining_eth', 'rollover.rolled_eth'].includes(id))) {
        metrics[id] = { ...metrics[id], value: null, applicability: 'NA', complete: true, observedAt: risk.observedAt / 1000,
          evidence: 'Complete positions prove no remaining old legs; no rollover preview is required', reason: 'No remaining old legs' };
      }
      return metrics;
    }
    if (profile.oldMaturity <= now) throw new Error('Old legs matured — rollover preview must stop');
    const full = await read('/boros/roll/simulate', watchRequest(scope.address!, progress.remaining)) as WatchSimulation;
    const fullState = watchPreview(full, progress.remaining, Date.now() / 1000);
    const observedAt = Math.min(full.simulatedAtMs, risk.observedAt) / 1000;
    const fullDetails: Detail[] = [
      { label: 'Remaining old / rolled new', value: `${progress.remaining} / ${progress.rolled}`, unit: 'ETH per venue' },
      { label: 'Full remaining preview', value: fullState.ready === null ? 'UNKNOWN' : String(fullState.ready), unit: '' },
      { label: 'Full remaining depth', value: fullState.depth, unit: 'ETH' },
      { label: 'Full remaining blockers', value: full.gate.blockers.map(b => `${b.code}: ${b.message}`).join('; ') || 'none', unit: '' },
      { label: 'Batch sequence', value: 'Each batch requires a new quote and preview after receipt/events and old+new=total reconciliation; unknown/pending execution forbids resubmission. These probes do not consume depth or prove later batches.', unit: '' },
    ];
    put('rollover.full_batch_ready', fullState.ready, observedAt, fullDetails);
    let sim: WatchSimulation | null = fullState.ready === true ? full : null;
    let size = progress.remaining;
    const probes: Detail[] = [];
    if (!sim && fullState.ready === false && fullState.depth !== null
      && finite(full.gasBalanceUsd) && full.gasBalanceUsd >= profile.gasMinimumUsd) {
      const upper = Math.min(progress.remaining, fullState.depth);
      let previous: number | null = upper >= progress.remaining - 1e-9 ? progress.remaining : null;
      for (let attempt = 0; attempt < profile.maxProbes; attempt++) {
        const candidate = nextWatchProbe(upper, previous, full.entry.simulation.collateralPriceUsd);
        if (candidate === null) break;
        try {
          const result = await read('/boros/roll/simulate', watchRequest(scope.address!, candidate)) as WatchSimulation;
          const state = watchPreview(result, candidate, Date.now() / 1000);
          probes.push({ label: `Probe ${candidate} ETH`, value: state.ready === null ? 'UNKNOWN' : String(state.ready), unit: '' });
          if (state.ready === true) { sim = result; size = candidate; break; }
          if (state.ready === null) break;
        } catch {
          probes.push({ label: `Probe ${candidate} ETH`, value: 'UNKNOWN — read/identity/size/time validation failed', unit: '' });
          break;
        }
        previous = candidate;
      }
    }
    const path = sim ? fullState.ready === true ? 'FULL_PREVIEW' : 'A_PRIME' : 'UNKNOWN';
    put('rollover.roll_path', path, observedAt, [...fullDetails, ...probes,
      { label: 'Interpretation', value: sim ? path === 'A_PRIME' ? 'A′ candidate: only this batch is previewable; full remaining size is blocked' : 'Full-size preview available; first real receipt trial remains required' : 'No verified batch this run; not proof that every size is impossible', unit: '' }]);
    put('rollover.batch_size_eth', sim ? size : null, observedAt, [...fullDetails, ...probes]);
    if (!sim) {
      metrics['rollover.atomic_batch_ready'].details = [...fullDetails, ...probes];
      metrics['rollover.atomic_batch_ready'].reason = 'No verified candidate; full-size failure alone does not prove A′ impossible';
      return metrics;
    }
    const selected = watchPreview(sim, size, Date.now() / 1000);
    const batchTime = Math.min(sim.simulatedAtMs, risk.observedAt) / 1000;
    const legs = selected.legs;
    const details: Detail[] = [
      ...fullDetails, ...probes,
      { label: 'Selected batch', value: size, unit: 'ETH per leg' },
      { label: 'Plan', value: '198 OKX LONG → 213 OKX LONG; 196 Hyperliquid SHORT → 209 Hyperliquid SHORT', unit: '' },
      { label: 'G', value: 'VERIFIED 2026-10-17 — each batch is four-leg FOK; docs/rollover_watch.md', unit: '' },
      { label: 'Execution receipt', value: 'UNKNOWN — position conservation and previews do not prove a real receipt; verify receipt/events before the next batch', unit: '' },
      { label: 'Execution admission', value: 'UNKNOWN — per-batch gas/relayer cost, cumulative budget, income review, deadline and operator attendance require approval. A/A′ are preview candidates, not execution authorization.', unit: '' },
      { label: 'Blockers', value: sim.gate.blockers.map(b => `${b.code}: ${b.message}`).join('; ') || 'none', unit: '' },
      { label: 'Warnings', value: sim.gate.warnings.join('; ') || 'none', unit: '' },
    ];
    for (const l of legs) details.push(
      { label: `${l.marketId} exec`, value: l.execApr, unit: 'APR fraction' },
      { label: `${l.marketId} mid`, value: l.midApr ?? null, unit: 'APR fraction' },
      { label: `${l.marketId} |exec-mid|`, value: finite(l.execApr) && finite(l.midApr) ? Math.abs(l.execApr - l.midApr) : null, unit: 'APR fraction' },
      { label: `${l.marketId} tolerance`, value: l.slippageApr, unit: 'APR fraction' },
      { label: `${l.marketId} depth within tolerance`, value: l.sizeWithinTolerance ?? null, unit: 'ETH' });
    const price = sim.entry.simulation.collateralPriceUsd, margin = sim.gate.margin;
    put('rollover.depth_coverage_ratio', selected.coverage, batchTime, details);
    const s = sim.entry.simulation;
    const feesUnknown = [...s.reasons, ...sim.gate.warnings, ...sim.entry.gate.warnings].some(w => /fees? assume|fallback/i.test(w));
    put('rollover.next_net_apr', !feesUnknown && finite(s.estSpreadApr) && finite(s.takerDragApr) ? s.estSpreadApr - s.takerDragApr : null,
      batchTime, [{ label: 'Net APR', value: `Live selected-batch (${size} ETH) estSpreadApr − takerDragApr; settlement fees already included. Excludes extra per-batch gas/relayer costs.`, unit: '' },
        ...await dailyDetails(deps.dataDir, now, progress.remaining, size).catch(() => [{ label: 'Daily v2 watch', value: 'UNKNOWN — ledger read failed', unit: '' }])], feesUnknown ? 'Fee fallback is not verified executable net APR' : undefined);
    const marginDetails: Detail[] = [
      { label: 'Selected batch', value: size, unit: 'ETH per leg' },
      ...['need', 'availableBefore', 'availableAfterExit', 'availableAfter'].map(k => ({ label: `Atomic ${k}`, value: finite(margin[k as keyof typeof margin]) ? margin[k as keyof typeof margin]! : null, unit: 'ETH' })),
      { label: 'Gas balance (separate from cost)', value: sim.gasBalanceUsd, unit: 'USD' },
      { label: 'Margin model', value: 'Selected batch only: closes then opens. No full-roll or future-batch account coverage is inferred.', unit: '' },
      { label: 'Venue preview', value: sim.venue?.status ?? 'UNKNOWN', unit: '' },
    ];
    put('rollover.atomic_batch_ready', selected.ready, batchTime, details);
    const usd = (v: unknown) => finite(price) && price > 0 && finite(v) ? v * price : null;
    put('rollover.atomic_margin_need_usd', usd(margin.need), batchTime, marginDetails);
    put('rollover.atomic_available_after_usd', usd(margin.availableAfter), batchTime, marginDetails);
    put('rollover.atomic_margin_shortfall_usd', usd(margin.shortfall), batchTime, marginDetails);
  } catch (err) {
    for (const id of ids) put(id, null, null, undefined, err instanceof Error ? err.message : 'Rollover read failed');
  }
  return metrics;
}
