import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rolloverEvidence, WATCH_ADDRESS as address } from '../../src/server/rolloverEvidence';
import { evaluateRisk, type RiskScope } from '../../src/core/risk';
import type { AppDeps } from '../../src/server/app';

const now = 1792280000, size = 3.9888313;
const scope: RiskScope = { credentialId: 'fixture', address, accountId: 0, pool: 'account' };
const headers = { host: 'localhost:6688', 'x-arb-token': 'synthetic-token' };
const temporary: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  vi.stubEnv('BOROS_ROOT_ADDRESS', address);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'roll-evidence-')); temporary.push(dataDir);
  mkdirSync(path.join(dataDir, 'risk-monitor'));
  const positions = [198, 196].map((marketId, i) => ({ marketId, marketAcc: address + '000002ffffff',
    tokenId: 2, base: 'ETH', venue: i ? 'HYPERLIQUID' : 'OKX', side: i ? 'SHORT' : 'LONG', sizeToken: size,
    entryApr: i ? .077667 : .031072, maturity: 1793318400 }));
  const asset = { risk: { version: 2, address, accountId: 0, positionsComplete: true, stale: false, observedAt: now * 1000, positions } };
  const legs = [198, 196, 213, 209].map((marketId, i) => ({ marketId, base: 'ETH', venue: i % 2 ? 'Hyperliquid' : 'OKX',
    direction: i === 0 || i === 3 ? 'short' : 'long', bookStatus: 'ok', execApr: .06, midApr: .06,
    slippageApr: i < 2 ? .005 : .0025, sizeWithinTolerance: 10, sizing: { deltaSize: i === 0 || i === 3 ? -size : size,
      orderSide: i === 0 || i === 3 ? 'short' : 'long' } }));
  const step = (rows: typeof legs, maturity: number) => ({ simulation: { legs: rows, collateral: 'ETH', collateralPriceUsd: 2500,
    secondsToMaturity: maturity - now, estSpreadApr: .025, takerDragApr: .001, reasons: [] as string[] }, gate: { warnings: [] as string[] } });
  const sim = { simulatedAtMs: now * 1000, gasBalanceUsd: 5,
    exit: step(legs.slice(0, 2), 1793318400), entry: step(legs.slice(2), 1795737600),
    gate: { blockers: [] as { code: string; message: string }[], warnings: [],
      margin: { need: .04, availableBefore: .06, availableAfterExit: .1 as number | null, availableAfter: .06 as number | null, shortfall: 0 } },
    venue: { status: 'Succeed', orders: legs.map((l, i) => ({ marketId: l.marketId, action: i < 2 ? 'close' : 'open', filled: true,
      matchedSize: size, error: null as string | null })) } };
  const calls: { method: string; url: string; body: unknown }[] = [];
  const app = Fastify();
  let stale = false, fails = false;
  let simulator: ((q: number) => typeof sim) | null = null;
  const replyData = (data: unknown) => ({ ok: true, data, meta: { ts: now * 1000, credentialId: 'fixture', stale } });
  app.get('/api/asset-view/:address', async req => { calls.push({ method: req.method, url: req.url, body: req.body }); return replyData(asset); });
  app.post('/api/boros/roll/simulate', async (req, reply) => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    const q = (req.body as { exit: { legs: { size: number }[] } }).exit.legs[0].size;
    return fails ? reply.code(503).send({ ok: false })
      : { ok: true, data: simulator ? simulator(q) : sim, meta: { ts: now * 1000, credentialId: 'fixture', stale } };
  });
  const read = async (selected = scope) => {
    try { return await rolloverEvidence(app, { dataDir } as AppDeps, selected, headers); }
    finally { await app.close(); }
  };
  const resize = (q: number) => {
    const result = structuredClone(sim);
    for (const step of [result.exit, result.entry]) for (const leg of step.simulation.legs) leg.sizing.deltaSize = Math.sign(leg.sizing.deltaSize) * q;
    result.venue.orders.forEach(o => { o.matchedSize = q; });
    return result;
  };
  return { asset, sim, legs, calls, dataDir, read, resize, setSimulator: (fn: (q: number) => typeof sim) => { simulator = fn; },
    setStale: () => { stale = true; }, setFailure: () => { fails = true; } };
}

describe('watch-profile read-only four-leg evidence', () => {
  it('uses only asset GET and the allowed simulate POST; reports actual-size net APR and atomic margin', async () => {
    const f = fixture(), metrics = await f.read();
    expect(f.calls.map(c => c.method + ' ' + c.url)).toEqual(['GET /api/asset-view/' + address, 'POST /api/boros/roll/simulate']);
    expect(f.calls[1].body).toMatchObject({ exit: { legs: [{ marketId: 198, slippageApr: .005, size }, { marketId: 196, slippageApr: .005, size }] },
      entry: { legs: [{ marketId: 213, size }, { marketId: 209, size }] } });
    expect(metrics['rollover.next_net_apr'].value).toBeCloseTo(.024);
    expect(metrics['rollover.depth_coverage_ratio'].value).toBe(1);
    expect(metrics['rollover.atomic_batch_ready'].value).toBe(true);
    expect(metrics['rollover.atomic_margin_need_usd'].value).toBe(100);
    expect(metrics['rollover.atomic_available_after_usd'].value).toBe(150);
    expect(metrics['rollover.post_roll_coverage']).toBeUndefined();
    expect(metrics['rollover.atomic_batch_ready'].details).toContainEqual(expect.objectContaining({ label: 'Execution receipt', value: expect.stringContaining('UNKNOWN') }));
    const check = evaluateRisk(scope, metrics, now).checks.find(c => c.id === 'rollover.incremental_margin_usd')!;
    expect(check.label).toBe('6. 原子展期预检与保证金');
    expect(check.status).toBe('WARNING');
    expect(metrics['rollover.execution_admission'].value).toBe('UNKNOWN');
    expect(evaluateRisk(scope, metrics, now + 121).checks.find(c => c.id === check.id)?.status).toBe('UNKNOWN');
  });
  it('keeps a refused batch and unknown after-state visible despite a zero default shortfall', async () => {
    const f = fixture();
    f.sim.venue.status = 'Refused'; f.sim.venue.orders.forEach(o => { o.filled = false; });
    f.sim.gate.blockers.push({ code: 'venue-refused', message: 'FOK not filled' });
    f.sim.gate.margin.availableAfter = null; f.sim.gate.margin.availableAfterExit = null;
    f.legs[0].sizeWithinTolerance = 2;
    const metrics = await f.read();
    expect(metrics['rollover.full_batch_ready'].value).toBe(false);
    expect(metrics['rollover.atomic_batch_ready'].value).toBeNull();
    expect(metrics['rollover.atomic_available_after_usd'].value).toBeNull();
    expect(metrics['rollover.atomic_margin_shortfall_usd'].value).toBeNull();
    const check = evaluateRisk(scope, metrics, now).checks.find(c => c.id === 'rollover.incremental_margin_usd')!;
    expect(check.status).toBe('WARNING'); expect(check.coverageComplete).toBe(false);
  });
  it('keeps A′ available when full size fails but an independently simulated smaller batch succeeds', async () => {
    const f = fixture();
    f.setSimulator(q => {
      const s = f.resize(q);
      s.entry.simulation.legs[1].sizeWithinTolerance = 1.980117;
      if (q > 1.99) {
        s.venue.status = 'Refused'; s.venue.orders.forEach(o => { o.filled = false; });
        s.gate.blockers.push({ code: 'venue-refused', message: 'FOK depth insufficient' });
        s.gate.margin.availableAfter = null; s.gate.margin.availableAfterExit = null;
      }
      return s;
    });
    const m = await f.read();
    expect(m['rollover.full_batch_ready'].value).toBe(false);
    expect(m['rollover.atomic_batch_ready'].value).toBe(true);
    expect(m['rollover.roll_path'].value).toBe('A_PRIME');
    expect(m['rollover.batch_size_eth'].value).toBe(1.98);
    expect(m['rollover.depth_coverage_ratio'].value).toBe(1);
    expect(m['rollover.atomic_available_after_usd'].value).toBe(150);
    expect(m['rollover.atomic_batch_ready'].details).toContainEqual(expect.objectContaining({ label: 'Execution admission', value: expect.stringContaining('UNKNOWN') }));
    const c = evaluateRisk(scope, m, now).checks.find(c => c.id === 'rollover.incremental_margin_usd')!;
    expect(c.status).toBe('WARNING'); expect(c.coverageComplete).toBe(true);
    expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(2);
  });
  it('accepts balanced partial progress and previews only the remaining old size', async () => {
    const f = fixture();
    const rows = f.asset.risk.positions;
    rows.forEach(p => { p.sizeToken = size - 1; });
    rows.push(...rows.map(p => ({ ...p, marketId: p.marketId === 198 ? 213 : 209, maturity: 1795737600, sizeToken: 1, entryApr: .05 })));
    f.setSimulator(q => f.resize(q));
    const m = await f.read();
    expect(m['rollover.remaining_eth'].value).toBeCloseTo(size - 1);
    expect(m['rollover.rolled_eth'].value).toBe(1);
    expect(m['rollover.batch_size_eth'].value).toBeCloseTo(size - 1);
    expect(m['rollover.atomic_batch_ready'].value).toBe(true);
  });
  it('marks preview measurements NA only when complete positions prove the watch has finished', async () => {
    const f = fixture(); f.asset.risk.positions = [];
    const m = await f.read();
    expect(m['rollover.roll_path'].value).toBe('DONE');
    expect(m['rollover.remaining_eth'].value).toBe(0);
    expect(m['rollover.atomic_batch_ready'].applicability).toBe('NA');
    expect(evaluateRisk(scope, m, now).checks.find(c => c.id === 'rollover.incremental_margin_usd')?.status).toBe('OK');
    expect(f.calls).toHaveLength(1);
  });
  it.each(['scope', 'subaccount', 'quantity', 'entry', 'venue', 'maturity', 'stale', 'failed', 'partial-venue', 'partial-leg', 'missing-gas', 'fees', 'asset-time', 'sim-time'])(
    'fails closed for %s evidence', async kind => {
      const f = fixture();
      const selected = { ...scope };
      if (kind === 'scope') selected.address = '0x' + '1'.repeat(40);
      if (kind === 'subaccount') selected.accountId = 1;
      if (kind === 'quantity') f.asset.risk.positions[0].sizeToken = 3;
      if (kind === 'entry') f.asset.risk.positions[0].entryApr = .04;
      if (kind === 'venue') f.asset.risk.positions[0].venue = 'BINANCE';
      if (kind === 'maturity') f.sim.entry.simulation.secondsToMaturity += 86400;
      if (kind === 'stale') f.setStale();
      if (kind === 'failed') f.setFailure();
      if (kind === 'partial-venue') f.sim.venue.orders.pop();
      if (kind === 'partial-leg') f.sim.entry.simulation.legs[0].sizing.deltaSize = 2;
      if (kind === 'missing-gas') f.sim.gasBalanceUsd = NaN;
      if (kind === 'fees') f.sim.entry.simulation.reasons.push('fees assume fallback');
      if (kind === 'asset-time') f.asset.risk.observedAt = NaN;
      if (kind === 'sim-time') f.sim.simulatedAtMs = NaN;
      const m = await f.read(selected);
      if (kind === 'scope' || kind === 'subaccount') { expect(m).toEqual({}); expect(f.calls).toEqual([]); }
      else if (kind === 'fees') expect(m['rollover.next_net_apr'].value).toBeNull();
      else expect(m['rollover.atomic_batch_ready'].value).toBeNull();
    });
  it.each(['localhost', '127.0.0.1'])('shows scoped v3 cash and risk-adjusted economics from %s without mixing legacy profit', async host => {
    const f = fixture();
    const row = { v: 3, quote_size_eth: size, remaining_eth: size, ts: '2026-10-18', now_unix: now - 30, S: .025, E: .03, S_r_star: .027, S_cons: .024, M: -.003,
      S_r_star_cash: .022, A_minus_B_cash_ref_usd: -.6, A_minus_B_risk_adjusted_ref_usd: 1.2, settlement_A_usd: 1,
      watch_scope: { address, account_id: 0, size, terminal: `http://${host}:6688` }, sample_count: 3, sample_interval_seconds: 60 };
    writeFileSync(path.join(f.dataDir, 'risk-monitor/rollover-watch.jsonl'), [row, { ...row, v: 2, M: 999 }, { ...row, v: 1, S_star: 999 }].map(r => JSON.stringify(r)).join('\n'));
    const m = await f.read();
    expect(m['rollover.next_net_apr'].details).toContainEqual({ label: 'Daily M', value: -.003, unit: 'APR fraction' });
    expect(m['rollover.next_net_apr'].details).toContainEqual({ label: 'Daily A_minus_B_cash_ref_usd', value: -.6, unit: 'USD' });
    expect(m['rollover.next_net_apr'].details).toContainEqual({ label: 'Daily S_r_star_cash', value: .022, unit: 'APR fraction' });
    expect(m['rollover.next_net_apr'].value).toBeCloseTo(.024);
  });
  it('keeps daily profit unknown when only legacy v2 rows exist', async () => {
    const f = fixture();
    writeFileSync(path.join(f.dataDir, 'risk-monitor/rollover-watch.jsonl'), JSON.stringify({ v: 2, now_unix: now - 1, A_usd: 999 }));
    const m = await f.read();
    expect(m['rollover.next_net_apr'].details).toContainEqual({ label: 'Daily v3 watch', value: 'UNKNOWN — no valid v3 record; v1/v2 fee and profit semantics are incompatible', unit: '' });
    expect(m['rollover.next_net_apr'].value).toBeCloseTo(.024);
  });
});
