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
  const scope: RiskScope = { credentialId: credentialIdentity(deps), address, accountId: 0, pool: 'ETH-cross' };
  const meta = { ts: now * 1000, observedAt: now * 1000, credentialId: scope.credentialId, coverageComplete: true };
  const legs = ['HYPERLIQUID', 'BINANCE'].map((exchange, i) => ({ exchange,
    symbol: exchange + '_FUTURE_ETH_' + (i ? 'USDT' : 'USDC'), side: i ? 'LONG' : 'SHORT', qty: 3, value: 9000 }));
  const boros = legs.map((p, i) => ({ marketAcc: pool, marketId: 128 + i, venue: p.exchange, side: p.side,
    sizeToken: 3.00013, maturity: now + 80 * 86400, entryApr: i ? .04 : .08, markApr: i ? .04 : .08,
    mtmUsd: 0, notionalUsd: 9000, settleFeeApr: .001 }));
  const snapshots: Record<string, any> = {
    account: { userId: 'gate-user', marginBalance: '200', initialMargin: '100', maintenanceMargin: '50',
      assets: [{ coin: 'USDT', exchangeType: 'BINANCE', liability: '0' }, { coin: 'USDC', exchangeType: 'HYPERLIQUID', liability: '0' }] },
    positions: { positions: legs.map((p, i) => ({ symbol: p.symbol, positionQty: i ? '3' : '-3', markPrice: '3000', upnl: '0', updateTime: String(now * 1000) })),
      exposure: [{ base: 'ETH', legs }] },
    interest: { buckets: [{ coin: 'USDT', venue: 'BINANCE', borrow: 0, interestPerDayUsd: 0 }, { coin: 'USDC', venue: 'HYPERLIQUID', borrow: 0, interestPerDayUsd: 0 }] },
    collateral: { address, accountId: 0, observedAt: now * 1000, stale: false, tokens: [{ tokenId: 2, priceUsd: 3000,
      cross: { marketAcc: pool, netBalance: .1, initialMargin: .04, maintenanceMargin: .02, availableInitialMargin: .04, imCoverage: 2.5, mmCoverage: 5 }, isolated: [] }] },
    asset: { assets: [], warnings: [], coverage: { borosPositionsComplete: true, borosTxnsComplete: true, backfilling: false },
      risk: { address, accountId: 0, observedAt: now * 1000, stale: false, positionsComplete: true, positions: boros,
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

  it('preserves critical recovery across a terminal restart only for the proven same Gate user and pool', async () => {
    const f = await fixture(); f.failed.add('positions');
    const previous = { scope: { ...f.scope, credentialId: 'before-restart' },
      producerScope: { root: address, account_id: 0, base: 'ETH', collateral_token_id: 2,
        gate_user_id: 'gate-user', terminal_url: 'http://localhost:6688' },
      state: { 'hedge.perp_net_eth': { status: 'CRITICAL', criticalMetrics: ['hedge.perp_net_eth'] } } };
    const read = async () => (await app.inject({ url: f.url + '&previous=' + encodeURIComponent(JSON.stringify(previous)), headers: HOST })).json().data;
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
