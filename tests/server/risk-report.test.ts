import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../src/server/app';
import { credentialIdentity } from '../../src/server/readScope';
import { riskReportRoutes } from '../../src/server/routes/riskReport';
import { evaluateRisk, visibleRiskChecks, type RiskScope } from '../../src/core/risk';
import { riskMeasurements, type RiskInputs } from '../../web/src/lib/riskSources';
import { HOST, makeTestApp } from './helpers/gate-nock';

const now = 1800000000, address = '0x' + '1'.repeat(40), pool = address + '000002ffffff';
let app: FastifyInstance;
afterEach(async () => { await app?.close(); vi.useRealTimers(); });

async function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  const deps = {} as AppDeps;
  const scope: RiskScope = { credentialId: credentialIdentity(deps), address, accountId: 0, pool: 'account' };
  const meta = { ts: now * 1000, observedAt: now * 1000, credentialId: scope.credentialId, coverageComplete: true };
  const legs = ['HYPERLIQUID', 'BINANCE'].map((exchange, i) => ({ exchange,
    symbol: exchange + '_FUTURE_ETH_' + (i ? 'USDT' : 'USDC'), quote: i ? 'USDT' : 'USDC', side: i ? 'LONG' : 'SHORT', qty: 3, value: 9000 }));
  const boros = legs.map((p, i) => ({ marketAcc: pool, marketId: 128 + i, venue: p.exchange, side: p.side,
    base: 'ETH', tokenId: 2, sizeBase: 3.00013, sizeToken: 3.00013, maturity: now + 80 * 86400, entryApr: i ? .04 : .08, markApr: i ? .04 : .08,
    mtmUsd: 0, notionalUsd: 9000, settleFeeApr: .001 }));
  const snapshots: Record<string, any> = {
    account: { userId: 'gate-user', marginBalance: '200', initialMargin: '100', maintenanceMargin: '50',
      assets: [{ coin: 'USDT', exchangeType: 'BINANCE', liability: '0' }, { coin: 'USDC', exchangeType: 'HYPERLIQUID', liability: '0' }] },
    positions: { positions: legs.map((p, i) => ({ symbol: p.symbol, positionQty: i ? '3' : '-3', markPrice: '3000', upnl: '0', updateTime: String(now * 1000) })),
      exposure: [{ base: 'ETH', legs }] },
    interest: { buckets: [{ coin: 'USDT', venue: 'BINANCE', borrow: 0, interestPerDayUsd: 0 }, { coin: 'USDC', venue: 'HYPERLIQUID', borrow: 0, interestPerDayUsd: 0 }] },
    collateral: { address, accountId: 0, observedAt: now * 1000, stale: false, tokens: [{ symbol: 'ETH', tokenId: 2, priceUsd: 3000,
      cross: { marketAcc: pool, activePositions: 2, netBalance: .1, initialMargin: .04, maintenanceMargin: .02, availableInitialMargin: .04, imCoverage: 2.5, mmCoverage: 5 }, isolated: [] }] },
    asset: { assets: [], warnings: [], coverage: { borosPositionsComplete: true, borosTxnsComplete: true, backfilling: false },
      risk: { version: 2, address, accountId: 0, observedAt: now * 1000, stale: false, positionsComplete: true, positions: boros,
        settlements: { pools: [], complete: true, fromSec: now - 86400, throughSec: now, reason: 'complete ledger' },
        settlement: { netEth: 0, complete: true, fromSec: now - 86400, throughSec: now, reason: 'complete ledger' } } },
    supplement: { scope, metrics: {}, baseline: null, fundingGapStartedAt: null, reason: '' },
    deals: [], orders: [], alerts: [], health: { status: 'ok' },
  };
  const paths = { account: '/account', positions: '/positions', interest: '/account/interest', collateral: '/boros/collateral',
    asset: `/asset-view/${address}`, supplement: '/risk/evidence', deals: '/deals', orders: '/orders/open', alerts: '/alerts', health: '/health' };
  const failed = new Set<string>(), stale = new Set<string>(), reads: string[] = [], assetUrls: string[] = [];
  app = Fastify();
  app.decorateReply('ok', function (data: unknown, options?: { observedAt?: number; coverageComplete?: boolean }) {
    return this.send({ ok: true, data, meta: { ...meta, ...options } });
  });
  for (const [key, path] of Object.entries(paths)) app.get('/api' + path, async (_req, reply) => {
    reads.push(key);
    if (key === 'asset') assetUrls.push(_req.url);
    if (failed.has(key)) return reply.code(503).send({ ok: false });
    return reply.send({ ok: true, data: snapshots[key], meta: { ...meta, stale: stale.has(key) } });
  });
  app.register(riskReportRoutes(deps), { prefix: '/api' });
  await app.ready();
  const url = `/api/risk/report?address=${address}&fresh=1`;
  return { scope, snapshots, meta, failed, stale, reads, assetUrls, url };
}

describe('read-only shared Risk report', () => {
  const readReport = async (f: Awaited<ReturnType<typeof fixture>>, previous?: unknown) => (await app.inject({
    url: f.url + (previous ? '&previous=' + encodeURIComponent(JSON.stringify(previous)) : ''), headers: HOST,
  })).json().data;
  const metric = (r: any, id: string) => r.checks.flatMap((c: any) => Object.entries(c.metrics)).find(([k]: any) => k === id)?.[1] as any;
  const addBtc = (f: Awaited<ReturnType<typeof fixture>>) => {
    const s = f.snapshots, acc = address + '000001ffffff';
    s.collateral.tokens.push({ symbol: 'BTC', tokenId: 1, priceUsd: 50000,
      cross: { marketAcc: acc, activePositions: 2, netBalance: .01, initialMargin: .002, maintenanceMargin: .001,
        availableInitialMargin: .001, imCoverage: 5, mmCoverage: 10 }, isolated: [] });
    for (const [venue, side, id] of [['HYPERLIQUID', 'SHORT', 300], ['OKX', 'LONG', 301]] as const) {
      const symbol = `${venue}_FUTURE_BTC_USDT`;
      s.positions.positions.push({ symbol, positionQty: side === 'SHORT' ? '-0.1' : '0.1', markPrice: '50000', upnl: '0', updateTime: String(now * 1000) });
      let g = s.positions.exposure.find((g: any) => g.base === 'BTC');
      if (!g) { g = { base: 'BTC', legs: [] }; s.positions.exposure.push(g); }
      g.legs.push({ symbol, exchange: venue, quote: 'USDT', side, qty: .1, value: 5000 });
      s.asset.risk.positions.push({ marketAcc: acc, marketId: id, venue, base: 'BTC', tokenId: 1, side,
        sizeToken: .1, sizeBase: .1, maturity: now + 80 * 86400, mtmUsd: 0, notionalUsd: 5000, entryApr: .05, markApr: .05 });
    }
    return acc;
  };
  it('handles two ETH maturities sharing one HL perp, including OKX, without pair PnL allocation', async () => {
    const f = await fixture(), s = f.snapshots;
    s.positions.positions[0].positionQty = '-7';
    s.positions.exposure[0].legs[0].qty = 7;
    s.positions.positions.push({ symbol: 'OKX_FUTURE_ETH_USDT', positionQty: '4', markPrice: '3000', upnl: '20', updateTime: String(now * 1000) });
    s.positions.exposure[0].legs.push({ symbol: 'OKX_FUTURE_ETH_USDT', exchange: 'OKX', quote: 'USDT', side: 'LONG', qty: 4, value: 12000 });
    for (const [venue, side, id] of [['HYPERLIQUID', 'SHORT', 196], ['OKX', 'LONG', 198]] as const) s.asset.risk.positions.push({
      ...s.asset.risk.positions[0], venue, side, marketId: id, sizeToken: 4.00083, sizeBase: 4.00083, maturity: now + 20 * 86400, mtmUsd: 2,
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
  it('supports BTC and keeps opposing ETH/BTC USD residuals from cancelling', async () => {
    const f = await fixture(); addBtc(f); const s = f.snapshots;
    s.positions.positions[1].positionQty = '3.01'; s.positions.exposure[0].legs[1].qty = 3.01;
    s.positions.positions[2].positionQty = '-0.1006'; s.positions.exposure[1].legs[0].qty = .1006;
    const r = await readReport(f);
    expect(metric(r, 'hedge.perp_net_eth').value).toBeCloseTo(.01);
    expect(metric(r, 'hedge.perp_net_btc').value).toBeCloseTo(-.0006);
    expect(metric(r, 'hedge.residual_usd').value).toBeCloseTo(60);
    expect(metric(r, 'hedge.residual_equity_ratio').value).toBeCloseTo(.3);
    expect(r.checks.find((c: any) => c.id === 'hedge.perp_net_eth').status).toBe('CRITICAL');
  });
  it('shows signed account inflow while an independent BTC outflow pool remains critical', async () => {
    const f = await fixture(), btc = addBtc(f), s = f.snapshots;
    s.collateral.tokens[1].cross.availableInitialMargin = .0001;
    s.asset.risk.settlements.pools = [{ marketAcc: pool, tokenId: 2, netToken: .01 }, { marketAcc: btc, tokenId: 1, netToken: -.0001 }];
    const r = await readReport(f);
    expect(metric(r, 'boros.settlement_net_24h_usd').value).toBe(25);
    expect(metric(r, 'boros.settlement_net_24h_btc').value).toBe(-.0001);
    expect(metric(r, 'boros.buffer_runway_days').value).toBe(1);
    expect(metric(r, 'boros.buffer_runway_days').details.some((d: any) => d.value === 'NA')).toBe(true);
    expect(r.checks.find((c: any) => c.id === 'boros.settlement_net_24h_eth').status).toBe('CRITICAL');
  });
  it('does not offset Gate account losses with Boros profits', async () => {
    const f = await fixture(); f.snapshots.positions.positions[0].upnl = '-30'; f.snapshots.asset.risk.positions[0].mtmUsd = 100;
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
