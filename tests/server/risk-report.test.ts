import type { FastifyInstance } from 'fastify';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateRisk, visibleRiskChecks, type RiskScope } from '../../src/core/risk';
import { riskMeasurements, type RiskInputs } from '../../web/src/lib/riskSources';
import { HOST, makeTestApp } from './helpers/gate-nock';
import { expiredResidualTests } from './helpers/expired-residual-tests';
import { buildRiskReportApp, now, address, pool } from './helpers/risk-report-fixture';

let app: FastifyInstance;
let tempDataDir: string | undefined;
afterEach(async () => {
  await app?.close();
  if (tempDataDir) rmSync(tempDataDir, { recursive: true, force: true });
  tempDataDir = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture(accountId = 0, actualAsset = false, signedSizes?: [string, string]) {
  const built = await buildRiskReportApp(accountId, actualAsset, signedSizes);
  app = built.app;
  tempDataDir = built.tempDataDir;
  return built;
}

describe('read-only shared Risk report', () => {
  const readReport = async (f: Awaited<ReturnType<typeof fixture>>, previous?: unknown) => (await app.inject({
    url: f.url + (previous ? '&previous=' + encodeURIComponent(JSON.stringify(previous)) : ''), headers: HOST,
  })).json().data;
  const metric = (r: any, id: string) => r.checks.flatMap((c: any) => Object.entries(c.metrics)).find(([k]: any) => k === id)?.[1] as any;
  it.each([
    ['8.025', '8.02630278', 'OK'],
    ['100', '100.02', 'OK'],
    ['0.01', '0.009', 'OK'],
    ['3', '3.006', 'WARNING'],
    ['0.1', '0.09', 'CRITICAL'],
  ])('grades funding size %s versus coverage %s by ratio and materiality', async (qty, coverage, status) => {
    const f = await fixture(), s = f.snapshots;
    s.positions.positions[0].positionQty = '-' + qty;
    s.positions.exposure[0].legs[0].qty = Number(qty);
    s.asset.risk.positions[0].sizeBase = coverage;
    const r = await readReport(f), c = r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth');
    expect(c.status).toBe(status);
    expect(metric(r, 'hedge.quantity_verified').value).toBe(status === 'OK');
    expect(metric(r, 'hedge.funding_gap_ratio').value).toBeCloseTo(Math.abs(Number(qty) - Number(coverage)) / Number(qty), 12);
  });
  it('exempts one verified executable lot while retaining its raw ratio and dollars', async () => {
    const f = await fixture(), s = f.snapshots;
    s.asset.risk.positions[0].sizeBase = '3.03';
    s.positions.quantitySteps = { HYPERLIQUID_FUTURE_ETH_USDC: { lotSize: '0.03', observedAt: now * 1000 } };
    const r = await readReport(f);
    expect(metric(r, 'hedge.funding_gap_ratio').value).toBe(.01);
    expect(metric(r, 'hedge.funding_gap_usd').value).toBeCloseTo(90, 10);
    expect(metric(r, 'hedge.quantity_verified').value).toBe(true);
    expect(r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('OK');
    s.positions.quantitySteps.HYPERLIQUID_FUTURE_ETH_USDC.observedAt = (now - 86401) * 1000;
    expect((await readReport(f)).checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('WARNING');
  });
  it.each(['perp', 'boros'])('never hides a missing %s side below the dollar floor', async missing => {
    const f = await fixture(), s = f.snapshots;
    s.positions.positions[0].positionQty = '-0.0001';
    s.positions.exposure[0].legs[0].qty = .0001;
    s.asset.risk.positions[0].sizeBase = '0.0001';
    if (missing === 'perp') { s.positions.positions.shift(); s.positions.exposure[0].legs.shift(); }
    else s.asset.risk.positions.shift();
    const r = await readReport(f);
    expect(metric(r, 'hedge.funding_unmatched').value).toBe(true);
    expect(metric(r, 'hedge.quantity_verified').value).toBe(false);
    expect(r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('CRITICAL');
  });
  it('never lets a sub-minimum dust leg own the rollover clock', async () => {
    const f = await fixture(), s = f.snapshots;
    s.asset.risk.positions.push({ ...s.asset.risk.positions[0], marketId: 196, sizeToken: .0008313, sizeBase: '0.0008313',
      maturity: now + 9 * 86400, mtmUsd: 0, mtmUsdExact: '0', notionalUsd: 1.98, notionalUsdExact: '1.98' });
    const r = await readReport(f);
    expect(metric(r, 'rollover.days_to_maturity').value).toBeCloseTo(80, 6);
    expect(r.checks.find((c: any) => c.id === 'rollover.days_to_maturity').status).toBe('OK');
    expect(r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('OK');
  });
  it('reports no rollover clock when only dust remains', async () => {
    const f = await fixture(), s = f.snapshots;
    // Exactly the minimum order value: the venue rejects that size too (its own
    // collateral quote makes $10 of USDT worth $9.998), so it must count as dust.
    s.asset.risk.positions.forEach((p: any) => { p.notionalUsd = 10; p.maturity = now + 9 * 86400; });
    const r = await readReport(f);
    expect(metric(r, 'rollover.days_to_maturity')).toMatchObject({ value: null, applicability: 'NA', complete: true });
    expect(r.checks.find((c: any) => c.id === 'rollover.days_to_maturity').status).toBe('OK');
  });
  it.each([
    ['3.003', 'OK'], ['3.003000000000000001', 'WARNING'],
    ['3.03', 'WARNING'], ['3.03000000000000001', 'CRITICAL'],
  ])('uses strict ratio boundaries for %s coverage', async (coverage, status) => {
    const f = await fixture(), s = f.snapshots;
    s.positions.positions[0].markPrice = '10000';
    s.asset.risk.positions[0].sizeBase = coverage;
    const r = await readReport(f);
    expect(r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe(status);
    expect(metric(r, 'hedge.quantity_verified').value).toBe(status === 'OK');
  });
  it.each([['3.01', 'OK'], ['3.010000000000000001', 'WARNING']])('uses a strict $10 materiality boundary for %s', async (coverage, status) => {
    const f = await fixture(), s = f.snapshots;
    s.positions.positions.forEach((p: any) => { p.markPrice = '1000'; });
    s.asset.risk.positions[0].sizeBase = coverage;
    expect((await readReport(f)).checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe(status);
  });
  it('shares custom ratio limits with quantity_verified and retains missing-side guards', async () => {
    const f = await fixture(), s = f.snapshots;
    s.asset.risk.positions[0].sizeBase = '3.006';
    s.supplement.settings = { thresholds: { 'hedge.hl_size_gap_eth': [
      ['hedge.funding_material_gap_ratio', 'gt', .005, 'WARNING'],
      ['hedge.funding_material_gap_ratio', 'gt', .02, 'CRITICAL'],
    ] }, recoveryMarginFraction: .03 };
    let r = await readReport(f);
    expect(r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('OK');
    expect(metric(r, 'hedge.quantity_verified').value).toBe(true);
    s.asset.risk.positions.shift();
    r = await readReport(f);
    expect(r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('CRITICAL');
    expect(metric(r, 'hedge.quantity_verified').value).toBe(false);
  });
  it('migrates legacy absolute overrides without reinterpreting ETH limits as ratios', async () => {
    const f = await fixture(), s = f.snapshots;
    s.asset.risk.positions[0].sizeBase = '3.00130278';
    s.supplement.settings = { thresholds: { 'hedge.hl_size_gap_eth': [
      ['hedge.hl_size_gap_eth', 'gt', .001, 'WARNING'],
    ] }, recoveryMarginFraction: .03 };
    const r = await readReport(f, { scope: f.scope, state: {
      'hedge.hl_size_gap_eth': { status: 'CRITICAL', criticalMetrics: ['hedge.hl_size_gap_eth'] },
    } });
    const c = r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth');
    expect(c.status).toBe('OK');
    expect(c.thresholds).toContainEqual(['hedge.funding_material_gap_ratio', 'gt', .001, 'WARNING']);
  });
  it('preserves missing valuation as UNKNOWN and unresolved ratio CRITICAL', async () => {
    const f = await fixture(), s = f.snapshots;
    s.asset.risk.positions[0].sizeBase = '3.006';
    s.positions.positions.forEach((p: any) => { p.markPrice = ''; });
    const r = await readReport(f);
    expect(metric(r, 'hedge.funding_gap_ratio').value).toBe(.002);
    expect(metric(r, 'hedge.funding_material_gap_ratio')).toMatchObject({ value: null, complete: false });
    expect(metric(r, 'hedge.quantity_verified').value).toBeNull();
    expect(r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('UNKNOWN');
    const previous = { scope: f.scope, state: { 'hedge.hl_size_gap_eth': {
      status: 'CRITICAL', criticalMetrics: ['hedge.funding_material_gap_ratio'],
    } } };
    expect((await readReport(f, previous)).checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('CRITICAL');
  });
  const addBtc = (f: Awaited<ReturnType<typeof fixture>>) => {
    const s = f.snapshots, acc = address + f.scope.accountId!.toString(16).padStart(2, '0') + '0001ffffff';
    s.collateral.tokens.push({ symbol: 'BTC', tokenId: 1, priceUsd: 50000,
      cross: { marketAcc: acc, activePositions: 2, netBalance: .01, netBalanceExact: '0.01', initialMargin: .002, maintenanceMargin: .001,
        availableInitialMargin: .001, imCoverage: 5, mmCoverage: 10 }, isolated: [] });
    for (const [venue, side, id] of [['HYPERLIQUID', 'SHORT', 300], ['OKX', 'LONG', 301]] as const) {
      const symbol = `${venue}_FUTURE_BTC_USDT`;
      s.positions.positions.push({ symbol, positionQty: side === 'SHORT' ? '-0.1' : '0.1', markPrice: '50000', upnl: '0', updateTime: String(now * 1000) });
      let g = s.positions.exposure.find((g: any) => g.base === 'BTC');
      if (!g) { g = { base: 'BTC', legs: [] }; s.positions.exposure.push(g); }
      g.legs.push({ symbol, exchange: venue, quote: 'USDT', side, qty: .1, value: 5000 });
      s.asset.risk.positions.push({ marketAcc: acc, marketId: id, venue, base: 'BTC', tokenId: 1, side,
        sizeToken: .1, sizeBase: '0.1', maturity: now + 80 * 86400, mtmUsd: 0, mtmUsdExact: '0',
        notionalUsd: 5000, notionalUsdExact: '5000', entryApr: .05, markApr: .05 });
    }
    return acc;
  };
  it('handles two ETH maturities sharing one HL perp, including OKX, without pair PnL allocation', async () => {
    const f = await fixture(), s = f.snapshots;
    s.positions.positions[0].positionQty = '-7';
    s.positions.exposure[0].legs[0].qty = 7;
    s.positions.positions.push({ symbol: 'OKX_FUTURE_ETH_USDT', positionQty: '4', markPrice: '3000', upnl: '20', updateTime: String(now * 1000) });
    s.account.assets[0].upnl = '20';
    s.positions.exposure[0].legs.push({ symbol: 'OKX_FUTURE_ETH_USDT', exchange: 'OKX', quote: 'USDT', side: 'LONG', qty: 4, value: 12000 });
    for (const [venue, side, id] of [['HYPERLIQUID', 'SHORT', 196], ['OKX', 'LONG', 198]] as const) s.asset.risk.positions.push({
      ...s.asset.risk.positions[0], venue, side, marketId: id, sizeToken: 4.00083, sizeBase: '4.00083', maturity: now + 20 * 86400,
      mtmUsd: 2, mtmUsdExact: '2', notionalUsdExact: '12002.49',
    });
    const r = await readReport(f);
    expect(r.complete).toBe(true);
    expect(metric(r, 'gate.upnl_usd').value).toBe(20);
    expect(metric(r, 'boros.rate_mtm_usd').value).toBe(4);
    expect(metric(r, 'hedge.perp_net_eth').value).toBe(0);
    expect(metric(r, 'hedge.hl_size_gap_eth').value).toBeCloseTo(.00096);
    for (const id of ['boros.adverse_spread_pp', 'boros.settlement_net_24h_eth', 'basis.mark_spread_usd_per_eth', 'hedge.perp_net_eth', 'hedge.hl_size_gap_eth', 'hedge.maturity_match']) {
      expect(r.checks.find((c: any) => c.id === id).status).toBe('OK');
    }
    expect(metric(r, 'boros.buffer_runway_days')).toMatchObject({ value: null, applicability: 'NA', complete: true });
  });
  it('keeps complete Boros evidence on a configured nonzero subaccount', async () => {
    const f = await fixture(3, true), r = await readReport(f);
    expect(f.borosCalls.some(call => call.includes('active-positions?root=' + address + '&accountId=3'))).toBe(true);
    expect(f.borosCalls.some(call => call.includes('settlement-events?root=' + address + '&accountId=3'))).toBe(true);
    expect(r.scope.accountId).toBe(3);
    expect(r.collection.farm.risk).toMatchObject({ accountId: 3, positionsComplete: true });
    expect(metric(r, 'data.coverage_complete').value).toBe(true);
    expect(r.complete).toBe(true);
  });
  it('preserves raw Boros 18-place quantities through the shared report and exact gap check', async () => {
    const signed = '1000000000000000001', f = await fixture(0, true, [`-${signed}`, signed]);
    f.snapshots.positions.positions[0].positionQty = '-1.000000000000000001';
    f.snapshots.positions.positions[1].positionQty = '1.000000000000000001';
    f.snapshots.positions.positions[1].symbol = 'OKX_FUTURE_ETH_USDT';
    f.snapshots.positions.exposure[0].legs[1].symbol = 'OKX_FUTURE_ETH_USDT';
    f.snapshots.positions.exposure[0].legs[1].exchange = 'OKX';
    f.snapshots.positions.exposure[0].legs[0].qty = 1;
    f.snapshots.positions.exposure[0].legs[1].qty = 1;
    const response = await app.inject({ url: f.url, headers: HOST });
    expect(response.statusCode, response.body).toBe(200);
    const r = response.json().data;
    expect(r.collection.farm.risk.positions.map((p: any) => p.sizeBase)).toEqual([
      '1.000000000000000001', '1.000000000000000001',
    ]);
    expect(metric(r, 'hedge.quantity_verified')).toMatchObject({ value: true, complete: true });
    expect(metric(r, 'hedge.quantity_verified').details.every((d: any) => d.value === 0)).toBe(true);
    expect(metric(r, 'data.coverage_complete').value).toBe(true);
    expect(r.complete).toBe(true);
  });
  it('does not require opposite Boros sides to balance within each maturity bucket', async () => {
    const f = await fixture();
    f.snapshots.asset.risk.positions[1].maturity += 86400;
    const r = await readReport(f);
    expect(metric(r, 'hedge.quantity_verified').value).toBe(true);
    expect(metric(r, 'hedge.direction_match').value).toBe(true);
    expect(metric(r, 'hedge.maturity_match').value).toBe(true);
    expect(r.checks.find((c: any) => c.id === 'hedge.maturity_match').status).toBe('OK');
  });
  it('still reports funding legs on the wrong side of their perpetual position', async () => {
    const f = await fixture();
    f.snapshots.asset.risk.positions[0].side = 'LONG';
    const r = await readReport(f);
    expect(metric(r, 'hedge.maturity_match').value).toBe(true);
    expect(metric(r, 'hedge.direction_match').value).toBe(false);
    expect(metric(r, 'hedge.quantity_verified').value).toBe(false);
  });
  it('does not count expired Boros legs as current funding coverage', async () => {
    const f = await fixture();
    f.snapshots.asset.risk.positions[0].maturity = now - 1;
    const r = await readReport(f);
    expect(metric(r, 'hedge.maturity_match').value).toBe(false);
    expect(metric(r, 'hedge.quantity_verified').value).toBe(false);
  });
  expiredResidualTests(fixture, readReport, metric, now);
  it('uses the same account loss thresholds when history or recovery margin changes', async () => {
    const f = await fixture();
    f.snapshots.positions.positions[0].upnl = '-30';
    f.snapshots.account.assets[0].upnl = '-30';
    f.snapshots.supplement.settings = { thresholds: {}, recoveryMarginFraction: .5 };
    const ruleId = 'basis.mark_spread_usd_per_eth';
    const status = (report: any) => report.checks.find((c: any) => c.id === ruleId).status;
    const clean = await readReport(f);
    const criticalHistory = await readReport(f, { scope: f.scope, state: {
      [ruleId]: { status: 'CRITICAL', criticalMetrics: ['gate.loss_equity_ratio'] },
    } });
    expect(status(clean)).toBe('WARNING');
    expect(status(criticalHistory)).toBe(status(clean));

    f.snapshots.positions.positions[0].upnl = '-24';
    f.snapshots.account.assets[0].upnl = '-24';
    const warningHistory = await readReport(f, { scope: f.scope, state: {
      [ruleId]: { status: 'WARNING', criticalMetrics: [] },
    } });
    expect(status(warningHistory)).toBe('WARNING');
  });
  it('keeps account PnL unknown when the account aggregate is unavailable', async () => {
    const f = await fixture();
    f.snapshots.account.assets = [];
    f.snapshots.positions.positions[0].upnl = '-5';
    f.snapshots.positions.positions[1].upnl = '-7';
    const r = await readReport(f);
    expect(metric(r, 'gate.upnl_usd')).toMatchObject({ value: null, complete: false });
    expect(metric(r, 'gate.loss_equity_ratio').value).toBeNull();
    expect(r.complete).toBe(false);
  });
  it('applies strict account loss thresholds at exactly 10% and 20%', async () => {
    const f = await fixture(), status = (r: any) => r.checks.find((c: any) => c.id === 'basis.mark_spread_usd_per_eth').status;
    f.snapshots.positions.positions[0].upnl = '-20';
    f.snapshots.account.assets[0].upnl = '-20';
    expect(metric(await readReport(f), 'gate.loss_equity_ratio').value).toBe(.1);
    expect(status(await readReport(f))).toBe('OK');
    f.snapshots.positions.positions[0].upnl = '-40';
    f.snapshots.account.assets[0].upnl = '-40';
    expect(metric(await readReport(f), 'gate.loss_equity_ratio').value).toBe(.2);
    expect(status(await readReport(f))).toBe('WARNING');
  });
  it.each(['0', '-1'])('never treats non-positive Gate equity %s as healthy', async equity => {
    const f = await fixture();
    f.snapshots.account.marginBalance = equity;
    const r = await readReport(f);
    expect(metric(r, 'gate.equity_positive')).toMatchObject({ value: false, complete: true });
    expect(metric(r, 'gate.loss_equity_ratio').value).toBeNull();
    expect(r.checks.find((c: any) => c.id === 'basis.mark_spread_usd_per_eth').status).toBe('CRITICAL');
  });
  it.each(['USDT', 'USDC'])('values %s collateral and settlement at 1:1 when no quote is supplied', async symbol => {
    const f = await fixture(), tokenId = 3, marketAcc = address + '000003ffffff';
    f.snapshots.collateral.tokens.push({ symbol, tokenId, priceUsd: null,
      cross: { marketAcc, activePositions: 0, netBalance: 100, netBalanceExact: '100', initialMargin: 0, maintenanceMargin: 0,
        availableInitialMargin: 100, imCoverage: null, mmCoverage: null }, isolated: [] });
    f.snapshots.asset.risk.settlements.pools.push({ marketAcc, tokenId, netToken: '10' });
    const r = await readReport(f);
    expect(metric(r, 'boros.equity_usd').value).toBe(400);
    expect(metric(r, 'boros.settlement_net_24h_usd').value).toBe(10);
    expect(metric(r, 'boros.settlement_net_24h_usd').details).toContainEqual(expect.objectContaining({ label: `${symbol} cross`, value: '10', unit: `${symbol}/24h` }));
    expect(metric(r, 'boros.settlement_net_24h_usd').details.find((d: any) => d.label === `${symbol} cross`).reason)
      .toContain('1:1');
  });
  it('keeps settlement USD unknown when a non-stablecoin quote is missing', async () => {
    const f = await fixture(), tokenId = 4, marketAcc = address + '000004ffffff';
    f.snapshots.collateral.tokens.push({ symbol: 'HYPE', tokenId, priceUsd: null,
      cross: { marketAcc, activePositions: 1, netBalance: 10, netBalanceExact: '10', initialMargin: 1, maintenanceMargin: .5,
        availableInitialMargin: 1, imCoverage: 10, mmCoverage: 20 }, isolated: [] });
    f.snapshots.asset.risk.settlements.pools.push({ marketAcc, tokenId, netToken: '2' });
    const r = await readReport(f);
    expect(metric(r, 'boros.settlement_net_24h_usd').value).toBeNull();
    expect(metric(r, 'boros.settlement_net_24h_usd').details).toContainEqual(expect.objectContaining({ label: 'HYPE cross', value: '2', unit: 'HYPE/24h' }));
    expect(JSON.stringify(metric(r, 'boros.settlement_net_24h_usd').details)).not.toContain(marketAcc);
    expect(r.checks.find((c: any) => c.id === 'boros.settlement_net_24h_eth').status).toBe('UNKNOWN');
  });
  it('preserves opposite settlement flows as separate collateral-pool details', async () => {
    const f = await fixture(), isolated = address + '000002000123';
    f.snapshots.collateral.tokens[0].isolated.push({ marketAcc: isolated, activePositions: 0, netBalance: 1, netBalanceExact: '1',
      initialMargin: 0, maintenanceMargin: 0, availableInitialMargin: 1, imCoverage: null, mmCoverage: null });
    f.snapshots.asset.risk.settlements.pools = [
      { marketAcc: pool, tokenId: 2, netToken: '10' },
      { marketAcc: isolated, tokenId: 2, netToken: '-10' },
    ];
    f.snapshots.collateral.tokens[0].priceUsd = 3000;
    const r = await readReport(f), details = metric(r, 'boros.settlement_net_24h_usd').details;
    expect(metric(r, 'boros.settlement_net_24h_usd').value).toBe(0);
    expect(details).toContainEqual(expect.objectContaining({ label: 'ETH cross', value: '10', unit: 'ETH/24h' }));
    expect(details).toContainEqual(expect.objectContaining({ label: 'ETH isolated 291', value: '-10', unit: 'ETH/24h' }));
    expect(details.every((d: any) => d.reason?.includes('observed at'))).toBe(true);
    expect(details[0].reason).toContain('priceUsd');
    expect(details[0].reason).toContain('3000');
    expect(details[0].reason).toContain(String(now * 1000));
  });
  it('calculates signed settlement USD from exact per-pool decimal amounts', async () => {
    const f = await fixture(), isolated = address + '000002000123';
    f.snapshots.collateral.tokens[0].isolated.push({ marketAcc: isolated, activePositions: 0, netBalance: 1, netBalanceExact: '1',
      initialMargin: 0, maintenanceMargin: 0, availableInitialMargin: 1, imCoverage: null, mmCoverage: null });
    f.snapshots.asset.risk.settlements.pools = [
      { marketAcc: pool, tokenId: 2, netToken: '0.100000000000000001' },
      { marketAcc: isolated, tokenId: 2, netToken: '-0.1' },
    ];
    f.snapshots.collateral.tokens[0].priceUsd = 3000;
    const r = await readReport(f), usd = metric(r, 'boros.settlement_net_24h_usd');
    expect(usd.value).toBeCloseTo(0.000000000000003, 25);
    expect(usd.details).toContainEqual(expect.objectContaining({ label: 'ETH cross', value: '0.100000000000000001', unit: 'ETH/24h' }));
    expect(usd.details).toContainEqual(expect.objectContaining({ label: 'ETH isolated 291', value: '-0.1', unit: 'ETH/24h' }));
    expect(usd.details.every((d: any) => d.reason?.includes('observed at'))).toBe(true);
    expect(metric(r, 'data.coverage_complete').value).toBe(true);
  });
  it('supports BTC and keeps opposing ETH/BTC USD residuals from cancelling', async () => {
    const f = await fixture(); addBtc(f); const s = f.snapshots;
    s.positions.positions[0].markPrice = '3001';
    s.positions.positions[1].positionQty = '3.01'; s.positions.exposure[0].legs[1].qty = 3.01;
    s.positions.positions[2].positionQty = '-0.1006'; s.positions.exposure[1].legs[0].qty = .1006;
    const r = await readReport(f);
    expect(metric(r, 'hedge.perp_net_eth').value).toBeCloseTo(.01);
    expect(metric(r, 'hedge.perp_net_btc').value).toBeCloseTo(-.0006);
    expect(metric(r, 'hedge.residual_usd').value).toBeCloseTo(60.01);
    expect(metric(r, 'hedge.residual_equity_ratio').value).toBeCloseTo(.3);
    expect(r.checks.find((c: any) => c.id === 'hedge.perp_net_eth').status).toBe('CRITICAL');
    expect(metric(r, 'hedge.residual_usd').details.find((d: any) => d.label === 'ETH').reason)
      .toContain('HYPERLIQUID_FUTURE_ETH_USDC');
    expect(metric(r, 'hedge.residual_usd').details.find((d: any) => d.label === 'ETH').reason)
      .toContain('markPrice 3001');
    expect(metric(r, 'hedge.residual_usd').details.find((d: any) => d.label === 'ETH').reason)
      .toContain(String(now));
    expect(metric(r, 'hedge.residual_usd').details.find((d: any) => d.label === 'ETH').reason)
      .toContain('USDC is valued at the fixed 1:1 USD assumption');
  });
  it('values sub-12-place residual quantities before converting the USD metric to a number', async () => {
    const f = await fixture(), s = f.snapshots;
    s.positions.positions[0].positionQty = '-0.000000000000000001';
    s.positions.positions[1].positionQty = '0.000000000000000002';
    s.positions.positions.forEach((p: any) => { p.markPrice = '1000000000000'; });
    s.positions.exposure[0].legs[0].qty = 1e-18;
    s.positions.exposure[0].legs[1].qty = 2e-18;
    s.asset.risk.positions[0].sizeBase = '0.000000000000000001';
    s.asset.risk.positions[1].sizeBase = '0.000000000000000002';
    const r = await readReport(f);
    expect(metric(r, 'hedge.perp_net_eth').value).toBe(1e-18);
    expect(metric(r, 'hedge.residual_usd').value).toBe(0.000001);
    expect(metric(r, 'hedge.quantity_verified').value).toBe(true);
    expect(metric(r, 'data.coverage_complete').value).toBe(true);
  });
  it('applies the same ratio and dollar tolerance to BTC funding tails', async () => {
    const f = await fixture(), btc = addBtc(f);
    f.snapshots.asset.risk.positions.find((p: any) => p.marketAcc === btc && p.side === 'SHORT').sizeBase = '0.100000000001';
    const r = await readReport(f);
    expect(metric(r, 'hedge.quantity_verified')).toMatchObject({ value: true, complete: true });
    expect(r.checks.find((c: any) => c.metrics?.['hedge.quantity_verified'])?.status).toBe('OK');
  });
  it('verifies an exact zero BTC quantity gap without an unconfigured tolerance', async () => {
    const f = await fixture(); addBtc(f);
    const r = await readReport(f);
    expect(metric(r, 'hedge.quantity_verified')).toMatchObject({ value: true, complete: true });
  });
  it('preserves exact signed ETH and BTC quantity totals from decimal position strings', async () => {
    const f = await fixture(); addBtc(f); const s = f.snapshots;
    const addLeg = (base: 'ETH' | 'BTC', venue: string, quote: string, side: 'LONG' | 'SHORT', qty: string) => {
      const symbol = `${venue}_FUTURE_${base}_${quote}`;
      s.positions.positions.push({ symbol, positionQty: side === 'SHORT' ? `-${qty}` : qty,
        markPrice: base === 'ETH' ? '3000' : '50000', upnl: '0', updateTime: String(now * 1000) });
      let group = s.positions.exposure.find((g: any) => g.base === base);
      if (!group) { group = { base, legs: [] }; s.positions.exposure.push(group); }
      group.legs.push({ symbol, exchange: venue, quote, side, qty: Number(qty), value: Number(qty) * (base === 'ETH' ? 3000 : 50000) });
      const tokenId = base === 'ETH' ? 2 : 1;
      const marketAcc = address + f.scope.accountId!.toString(16).padStart(2, '0') + tokenId.toString(16).padStart(4, '0') + 'ffffff';
      s.asset.risk.positions.push({ ...s.asset.risk.positions[0], marketAcc, venue, base, tokenId,
        side, marketId: 200 + s.asset.risk.positions.length,
        sizeToken: Number(qty), sizeBase: qty, maturity: now + 80 * 86400 });
    };

    s.positions.positions = [];
    s.positions.exposure = [];
    for (const [base, venue, side, qty] of [
      ['ETH', 'HYPERLIQUID', 'LONG', '0.1'], ['ETH', 'BINANCE', 'LONG', '0.2'], ['ETH', 'OKX', 'SHORT', '0.3'],
      ['BTC', 'HYPERLIQUID', 'LONG', '0.1'], ['BTC', 'OKX', 'LONG', '0.2'], ['BTC', 'BINANCE', 'SHORT', '0.3'],
    ] as const) addLeg(base, venue, base === 'ETH' && venue === 'HYPERLIQUID' ? 'USDC' : 'USDT', side, qty);

    const response = await app.inject({ url: f.url, headers: HOST });
    expect(response.statusCode, response.body).toBe(200);
    const r = response.json().data;
    expect(metric(r, 'gate.equity_usd').complete).toBe(true);
    expect(metric(r, 'hedge.perp_net_eth').value).toBe(0);
    expect(metric(r, 'hedge.perp_net_btc').value).toBe(0);
    expect(metric(r, 'hedge.residual_usd').value).toBe(0);
    expect(metric(r, 'data.coverage_complete').value).toBe(true);
  });
  it('calculates outflow runway with the live Boros collateral precision', async () => {
    const f = await fixture(), s = f.snapshots;
    s.collateral.tokens[0].cross.availableInitialMargin = .05665684587164302;
    s.asset.risk.settlements.pools = [{ marketAcc: pool, tokenId: 2, netToken: '-0.000001546202165018' }];
    const r = await readReport(f);
    const runway = metric(r, 'boros.buffer_runway_days');
    expect(runway.complete).toBe(true);
    expect(runway.value).toBeCloseTo(36642.58604306343, 8);
    expect(runway.details[0].value).toBe(runway.value);
    expect(r.checks.find((c: any) => c.id === 'boros.settlement_net_24h_eth').status).toBe('OK');
  });
  it.each([null, NaN])('keeps missing or invalid outflow collateral %s UNKNOWN', async available => {
    const f = await fixture(), s = f.snapshots;
    s.collateral.tokens[0].cross.availableInitialMargin = available;
    s.asset.risk.settlements.pools = [{ marketAcc: pool, tokenId: 2, netToken: '-0.000001546202165018' }];
    const r = await readReport(f);
    expect(metric(r, 'boros.buffer_runway_days')).toMatchObject({ value: null, complete: false });
    expect(r.checks.find((c: any) => c.id === 'boros.settlement_net_24h_eth').status).toBe('UNKNOWN');
  });
  it('shows signed account inflow while an independent BTC outflow pool remains critical', async () => {
    const f = await fixture(), btc = addBtc(f), s = f.snapshots;
    s.collateral.tokens[1].cross.availableInitialMargin = .0001;
    s.asset.risk.settlements.pools = [{ marketAcc: pool, tokenId: 2, netToken: '0.01' }, { marketAcc: btc, tokenId: 1, netToken: '-0.0001' }];
    const r = await readReport(f);
    expect(metric(r, 'boros.settlement_net_24h_usd').value).toBe(25);
    expect(metric(r, 'boros.settlement_net_24h_btc').value).toBe(-.0001);
    expect(metric(r, 'boros.buffer_runway_days').value).toBe(1);
    expect(metric(r, 'boros.buffer_runway_days').details.some((d: any) => d.value === 'NA')).toBe(true);
    expect(r.checks.find((c: any) => c.id === 'boros.settlement_net_24h_eth').status).toBe('CRITICAL');
  });
  it('does not offset Gate account losses with Boros profits', async () => {
    const f = await fixture(); f.snapshots.positions.positions[0].upnl = '-30'; f.snapshots.account.assets[0].upnl = '-30';
    f.snapshots.asset.risk.positions[0].mtmUsd = 100; f.snapshots.asset.risk.positions[0].mtmUsdExact = '100';
    const r = await readReport(f);
    expect(metric(r, 'gate.loss_equity_ratio').value).toBe(.15);
    expect(metric(r, 'boros.mtm_loss_equity_ratio').value).toBe(0);
    expect(r.checks.find((c: any) => c.id === 'basis.mark_spread_usd_per_eth').status).toBe('WARNING');
  });
  it('preserves threshold units and known legacy critical during account migration', async () => {
    const f = await fixture();
    const r = await readReport(f, { scope: { ...f.scope, pool: 'ETH-cross' }, state: {
      'basis.mark_spread_usd_per_eth': { status: 'CRITICAL', criticalMetrics: ['basis.loss_profit_ratio'] },
    } });
    const c = r.checks.find((c: any) => c.id === 'basis.mark_spread_usd_per_eth');
    expect(c.status).toBe('CRITICAL'); expect(c.reason).toContain('basis.loss_profit_ratio');
    expect(c.thresholds).toContainEqual(['gate.loss_equity_ratio', 'gt', .2, 'CRITICAL']);
  });
  it('fails closed for unsupported holdings, missing units, stale ledger and foreign pools', async () => {
    for (const change of [
      (s: any) => { s.positions.exposure[0].base = 'HYPE'; },
      (s: any) => { s.asset.risk.positions[0].sizeBase = null; },
      (s: any) => { s.asset.risk.settlements.complete = false; },
      (s: any) => { s.collateral.tokens[0].cross.marketAcc = '0x' + '2'.repeat(40) + '000002ffffff'; },
    ]) {
      const f = await fixture(); change(f.snapshots);
      const r = await readReport(f); expect(r.complete).toBe(false); expect(r.counts.UNKNOWN).toBeGreaterThan(0);
      await app.close();
    }
  });
  it('does not hide a known unhealthy pool when another pool lacks a price', async () => {
    const f = await fixture(); addBtc(f);
    f.snapshots.collateral.tokens[0].cross.netBalance = .001;
    f.snapshots.collateral.tokens[1].priceUsd = null;
    const r = await readReport(f);
    expect(r.complete).toBe(false);
    expect(r.checks.find((c: any) => c.id === 'boros.mm_health_ratio').status).toBe('CRITICAL');
    expect(metric(r, 'boros.mm_health_ratio').complete).toBe(false);
  });
  it('matches the page adapter and evaluator without a baseline, including its visible check set', async () => {
    const f = await fixture();
    const response = await app.inject({ url: f.url, headers: HOST });
    expect(response.statusCode).toBe(200);
    const report = response.json().data;
    const inputs = Object.fromEntries(Object.entries(f.snapshots).map(([key, data]) => [key, { data }])) as unknown as RiskInputs;
    const adapted = riskMeasurements(f.scope, inputs, now, false, () => f.meta);
    const expected = visibleRiskChecks(evaluateRisk(f.scope, adapted.metrics, now, {}, adapted.pauseRollover).checks);
    expect(report.checks).toEqual(expected);
    expect(report.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('OK');
    expect(report.checks.some((c: any) => c.risk === 8 || c.id === 'hedge.market_identity_match')).toBe(false);
    expect(report.counts.PAUSED).toBe(3);
    expect(report.complete).toBe(true);
    expect(f.reads[0]).toBe('account');
    expect(f.reads.at(-1)).toBe('supplement');
    expect(f.assetUrls.every(url => !new URL(url, 'http://localhost').searchParams.has('legSince')
      && !new URL(url, 'http://localhost').searchParams.has('since'))).toBe(true);
  });

  it('retains scoped prior CRITICAL when positions fail, and rejects another account history', async () => {
    const f = await fixture(); f.failed.add('positions');
    const state = { 'hedge.perp_net_eth': { status: 'CRITICAL', criticalMetrics: ['hedge.perp_net_eth'] } };
    const read = async (scope: RiskScope) => (await app.inject({ url: f.url + '&previous=' + encodeURIComponent(JSON.stringify({ scope, state })), headers: HOST })).json().data;
    const report = await read(f.scope);
    expect(report.complete).toBe(false);
    expect(report.errors.positions).toBe('Read failed');
    expect(report.checks.find((c: any) => c.id === 'hedge.perp_net_eth').status).toBe('CRITICAL');
    expect((await read({ ...f.scope, credentialId: 'other' })).checks.find((c: any) => c.id === 'hedge.perp_net_eth').status).toBe('UNKNOWN');
  });

  it('clears the legacy ETH absolute threshold after complete account recovery evidence', async () => {
    const f = await fixture(), s = f.snapshots;
    s.account.marginBalance = '1000000';
    s.positions.positions[1].positionQty = '3.02';
    s.positions.exposure[0].legs[1].qty = 3.02;
    const previous = { scope: f.scope, state: {
      'hedge.perp_net_eth': { status: 'CRITICAL', criticalMetrics: ['hedge.perp_net_eth'] },
    } };
    const report = await readReport(f, previous);
    expect(metric(report, 'hedge.perp_net_eth').value).toBeCloseTo(.02);
    expect(metric(report, 'hedge.residual_equity_ratio').value).toBeCloseTo(.00006);
    expect(report.checks.find((c: any) => c.id === 'hedge.perp_net_eth').status).toBe('OK');
    expect(report.complete).toBe(true);
  });

  it('keeps stale collateral UNKNOWN and incomplete instead of reusing its healthy numbers', async () => {
    const f = await fixture(); f.stale.add('collateral');
    const report = (await app.inject({ url: f.url, headers: HOST })).json().data;
    expect(report.checks.find((c: any) => c.id === 'boros.im_coverage').status).toBe('UNKNOWN');
    expect(report.complete).toBe(false);
  });

  it.each(['localhost:6688', '127.0.0.1:6688'])('preserves critical recovery across a terminal restart for the same subject at %s', async host => {
    const f = await fixture(); f.failed.add('positions');
    const previous = { scope: { ...f.scope, credentialId: 'before-restart' },
      producerScope: { root: address, account_id: 0, base: 'ETH', collateral_token_id: 2,
        gate_user_id: 'gate-user', terminal_url: 'http://localhost:6688' },
      state: { 'hedge.perp_net_eth': { status: 'CRITICAL', criticalMetrics: ['hedge.perp_net_eth'] } } };
    const read = async () => (await app.inject({ url: f.url + '&previous=' + encodeURIComponent(JSON.stringify(previous)), headers: { ...HOST, host } })).json().data;
    expect((await read()).checks.find((c: any) => c.id === 'hedge.perp_net_eth').status).toBe('CRITICAL');
    f.failed.add('account');
    expect((await read()).checks.find((c: any) => c.id === 'hedge.perp_net_eth').status).toBe('CRITICAL');
    f.failed.delete('account');
    previous.producerScope.gate_user_id = 'other-user';
    expect((await read()).checks.find((c: any) => c.id === 'hedge.perp_net_eth').status).toBe('UNKNOWN');
  });

  it('requires terminal authentication', async () => {
    app = makeTestApp();
    expect((await app.inject({ url: `/api/risk/report?address=${address}`, headers: { host: HOST.host } })).statusCode).toBe(401);
  });
});
