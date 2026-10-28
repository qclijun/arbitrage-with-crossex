/** The shared Risk report served over synthetic GET producers (tests/server/risk-report*.test.ts). */
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { AppDeps } from '../../../src/server/app';
import { TtlCache } from '../../../src/server/cache';
import { credentialIdentity } from '../../../src/server/readScope';
import { assetViewRoutes } from '../../../src/server/routes/assetView';
import { riskReportRoutes } from '../../../src/server/routes/riskReport';
import type { RiskScope } from '../../../src/core/risk';
import { borosStub } from '../../helpers/boros-stub';

export const now = 1800000000, address = '0x' + '1'.repeat(40), pool = address + '000002ffffff';

export function accountRiskBorosBodies(accountId: number, signedSizes: [string, string] = [
  '-3000000000000000000', '3000000000000000000',
]): Record<string, unknown> {
  const marketAcc = `${address}${accountId.toString(16).padStart(2, '0')}0002ffffff`;
  const raw = (n: number) => String(n * 1e18);
  const market = (marketId: number, venue: string) => ({ marketId, tokenId: 2,
    imData: { name: `${venue} ETH`, maturity: now + 80 * 86400 },
    extConfig: { settleFeeRate: '1000000000000000', paymentPeriod: 3600 },
    config: { status: 2 }, platform: { platformId: venue }, metadata: { underlyingSymbol: 'ETH' },
    data: { markApr: .05, floatingApr: .05, assetMarkPrice: 3000 } });
  const positions = [
    { marketId: 128, signedSize: signedSizes[0], initialMargin: raw(2), maintMargin: raw(1), liquidationApr: raw(.12), orders: [] },
    { marketId: 129, signedSize: signedSizes[1], initialMargin: raw(2), maintMargin: raw(1), liquidationApr: raw(.12), orders: [] },
  ];
  return {
    '/apis/v1/markets': { results: [market(128, 'Hyperliquid'), market(129, 'OKX')], total: 2, skip: 0 },
    '/apis/v1/accounts/market-acc-infos-by-root': { results: [{ marketAcc, netBalance: raw(200),
      initialMargin: raw(4), availableInitialMargin: raw(196), positions }] },
    '/apis/v1/accounts/active-positions': { results: [
      { marketAcc, marketId: 128, side: 1, fixedApr: .05, signedSize: signedSizes[0], unrealisedPnl: raw(0), settlementPnl: raw(0) },
      { marketAcc, marketId: 129, side: 0, fixedApr: .05, signedSize: signedSizes[1], unrealisedPnl: raw(0), settlementPnl: raw(0) },
    ] },
    '/apis/v1/accounts/settlement-events': { results: [], resumeToken: null },
    '/apis/v1/accounts/position-update-events': { results: [], resumeToken: null },
  };
}

export async function buildRiskReportApp(accountId = 0, actualAsset = false, signedSizes?: [string, string]) {
  let tempDataDir: string | undefined;
  vi.stubEnv('BOROS_ACCOUNT_ID', String(accountId));
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  const deps = {} as AppDeps;
  const accountPool = address + accountId.toString(16).padStart(2, '0') + '0002ffffff';
  const scope: RiskScope = { credentialId: credentialIdentity(deps), address, accountId, pool: 'account' };
  const meta = { ts: now * 1000, observedAt: now * 1000, credentialId: scope.credentialId, coverageComplete: true };
  const legs = ['HYPERLIQUID', 'BINANCE'].map((exchange, i) => ({ exchange,
    symbol: exchange + '_FUTURE_ETH_' + (i ? 'USDT' : 'USDC'), quote: i ? 'USDT' : 'USDC', side: i ? 'LONG' : 'SHORT', qty: 3, value: 9000 }));
  const boros = legs.map((p, i) => ({ marketAcc: accountPool, marketId: 128 + i, venue: p.exchange, side: p.side,
    base: 'ETH', tokenId: 2, sizeBase: '3.00013', sizeToken: 3.00013, maturity: now + 80 * 86400, entryApr: i ? .04 : .08, markApr: i ? .04 : .08,
    mtmUsd: 0, mtmUsdExact: '0', notionalUsd: 9000, notionalUsdExact: '9000', settleFeeApr: .001 }));
  const snapshots: Record<string, any> = {
    account: { userId: 'gate-user', marginBalance: '200', initialMargin: '100', maintenanceMargin: '50',
      assets: [{ coin: 'USDT', exchangeType: 'BINANCE', liability: '0', upnl: '0' }, { coin: 'USDC', exchangeType: 'HYPERLIQUID', liability: '0', upnl: '0' }] },
    positions: { positions: legs.map((p, i) => ({ symbol: p.symbol, positionQty: i ? '3' : '-3', markPrice: '3000', upnl: '0', updateTime: String(now * 1000) })),
      exposure: [{ base: 'ETH', legs }] },
    interest: { buckets: [{ coin: 'USDT', venue: 'BINANCE', borrow: 0, interestPerDayUsd: 0 }, { coin: 'USDC', venue: 'HYPERLIQUID', borrow: 0, interestPerDayUsd: 0 }] },
    collateral: { address, accountId, observedAt: now * 1000, stale: false, tokens: [{ symbol: 'ETH', tokenId: 2, priceUsd: 3000,
      cross: { marketAcc: accountPool, activePositions: 2, netBalance: .1, netBalanceExact: '0.1', initialMargin: .04, maintenanceMargin: .02, availableInitialMargin: .04, imCoverage: 2.5, mmCoverage: 5 }, isolated: [] }] },
    asset: { assets: [], warnings: [], coverage: { borosPositionsComplete: true, borosTxnsComplete: true, backfilling: false },
      risk: { version: 2, address, accountId, observedAt: now * 1000, stale: false, positionsComplete: true, positions: boros,
        settlements: { pools: [], complete: true, fromSec: now - 86400, throughSec: now, reason: 'complete ledger' },
        settlement: { netEth: 0, complete: true, fromSec: now - 86400, throughSec: now, reason: 'complete ledger' } } },
    supplement: { scope, metrics: {}, baseline: null, fundingGapStartedAt: null, reason: '' },
    deals: [], orders: [], alerts: [], health: { status: 'ok' }, slices: { slices: [], contracts: [] },
  };
  const paths = { account: '/account', positions: '/positions', interest: '/account/interest', collateral: '/boros/collateral',
    asset: `/asset-view/${address}`, supplement: '/risk/evidence', deals: '/deals', orders: '/orders/open', alerts: '/alerts', health: '/health',
    slices: '/slices' };
  const failed = new Set<string>(), stale = new Set<string>(), reads: string[] = [], assetUrls: string[] = [];
  const app = Fastify();
  app.decorateReply('ok', function (data: unknown, options?: { observedAt?: number; coverageComplete?: boolean }) {
    return this.send({ ok: true, data, meta: { ...meta, ...options } });
  });
  for (const [key, routePath] of Object.entries(paths)) {
    if (actualAsset && key === 'asset') continue;
    app.get('/api' + routePath, async (_req, reply) => {
      reads.push(key);
      if (key === 'asset') assetUrls.push(_req.url);
      if (failed.has(key)) return reply.code(503).send({ ok: false });
      return reply.send({ ok: true, data: snapshots[key], meta: { ...meta, stale: stale.has(key) } });
    });
  }
  const borosCalls: string[] = [];
  if (actualAsset) {
    tempDataDir = mkdtempSync(path.join(tmpdir(), 'risk-report-subaccount-'));
    const crossEx = new Proxy({}, { get: () => async () => ({ body: [] }) });
    Object.assign(deps, { cache: new TtlCache(), dataDir: tempDataDir,
      getClients: () => ({ crossEx }), borosFetch: borosStub(accountRiskBorosBodies(accountId, signedSizes), borosCalls) });
    app.register(assetViewRoutes(deps), { prefix: '/api' });
  }
  app.register(riskReportRoutes(deps), { prefix: '/api' });
  await app.ready();
  const url = `/api/risk/report?address=${address}&fresh=1`;
  return { app, tempDataDir, scope, snapshots, meta, failed, stale, reads, assetUrls, borosCalls, url };
}
