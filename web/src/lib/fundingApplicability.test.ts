/**
 * Ticket 16: only PROVEN floating two-leg quantity drops the Boros coverage
 * requirement — both legs actually held, both contracts reconciled on a fresh
 * reading, slice evidence at most 12 s old. Everything else keeps the old
 * funding checks, and price/margin risk never changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../api/client';
import type { SlicesResponse } from './fundingApplicability';
import { evaluateRisk, fundingGapFingerprint, type RiskScope } from './risk';
import { riskMeasurements, type RiskInputs } from './riskSources';

const now = 1800000000;
const address = '0x' + '1'.repeat(40);
const scope: RiskScope = { credentialId: 'fixture', address, accountId: 0, pool: 'account' };
const LONG = 'OKX_FUTURE_ETH_USDT';
const SHORT = 'HYPERLIQUID_FUTURE_ETH_USDC';

async function snapshot<T>(data: T, observedAt = now) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data,
    meta: { ts: observedAt * 1000, observedAt: observedAt * 1000, credentialId: scope.credentialId, coverageComplete: true } }))));
  return { data: await fetchJson<T>('/synthetic-risk-fixture') };
}
afterEach(() => vi.unstubAllGlobals());

/** A pure two-leg ETH pair (long OKX, short Hyperliquid), optionally with Boros legs. */
async function inputs(opts: { qty?: string; boros?: Array<{ venue: string; side: 'LONG' | 'SHORT'; size: string }> } = {}): Promise<RiskInputs> {
  const qty = opts.qty ?? '3';
  const legs = [
    { symbol: LONG, exchange: 'OKX', base: 'ETH', quote: 'USDT', side: 'LONG', qty: Number(qty), value: 9000 },
    { symbol: SHORT, exchange: 'HYPERLIQUID', base: 'ETH', quote: 'USDC', side: 'SHORT', qty: Number(qty), value: 9000 },
  ];
  const rows = legs.map((p) => ({ symbol: p.symbol, positionQty: p.side === 'SHORT' ? `-${qty}` : qty, markPrice: '3000', upnl: '0', updateTime: String(now * 1000) }));
  const pool = address + '000002ffffff';
  const boros = (opts.boros ?? []).map((b, i) => ({ marketAcc: pool, marketId: 200 + i, venue: b.venue, maturity: now + 30 * 86400, side: b.side,
    sizeToken: Number(b.size), sizeBase: b.size, entryApr: .05, markApr: .05, mtmUsd: 0, mtmUsdExact: '0', notionalUsd: 1000, settleFeeApr: .001, base: 'ETH', tokenId: 2 }));
  return {
    account: await snapshot({ marginBalance: '2000', initialMargin: '100', maintenanceMargin: '60', assets: [{ coin: 'USDT', exchangeType: 'OKX', liability: '0', upnl: '0' }] }),
    interest: await snapshot({ buckets: [] }),
    positions: await snapshot({ positions: rows, exposure: [{ base: 'ETH', legs }] }),
    collateral: await snapshot({ address, accountId: 0, observedAt: now * 1000, stale: false, tokens: [{ symbol: 'ETH', tokenId: 2, priceUsd: 3000,
      cross: { marketAcc: pool, netBalance: .1, netBalanceExact: '0.1', initialMargin: .04, maintenanceMargin: .02, availableInitialMargin: .04, imCoverage: 2.5, mmCoverage: 5 }, isolated: [] }] }),
    asset: await snapshot({ assets: [], warnings: [], coverage: { borosPositionsComplete: true, borosTxnsComplete: true, backfilling: false },
      risk: { version: 2, address, accountId: 0, observedAt: now * 1000, stale: false, positionsComplete: true, positions: boros,
        settlements: { complete: true, fromSec: now - 86400, throughSec: now, pools: [] } } }),
    supplement: await snapshot({ scope, metrics: {}, baseline: null, fundingGapStartedAt: null, reason: '' }),
    deals: await snapshot([]), orders: await snapshot([]), alerts: await snapshot([]), health: await snapshot({ status: 'ok' }),
  } as unknown as RiskInputs;
}

type Slice = SlicesResponse['slices'][number];
const twoLeg = (id: string, long: string, short: string, kind = 'funding-two-leg'): Slice => ({
  id, kind, source: {}, createdAt: 1, reducible: {},
  legs: [
    { leg: 'long', account: 'crossex', contract: LONG, side: 'long', unit: 'base', qty: long },
    { leg: 'short', account: 'crossex', contract: SHORT, side: 'short', unit: 'base', qty: short },
  ],
});
const reconciled = (contract: string, status = 'reconciled') => ({ contract, status, unknown: status !== 'reconciled', actual: null, explained: null, attributed: '0', unattributed: null });

async function withSlices(input: RiskInputs, slices: Slice[], opts: { status?: string; age?: number } = {}) {
  input.slices = await snapshot<SlicesResponse>({ slices, contracts: [reconciled(LONG, opts.status), reconciled(SHORT)] }, now - (opts.age ?? 0));
  return input;
}

const measure = (input: RiskInputs) => riskMeasurements(scope, input, now).metrics;
const status = (input: RiskInputs, id: string) => evaluateRisk(scope, measure(input), now).checks.find((c) => c.id === id)!.status;

describe('funding coverage applicability', () => {
  it('reports a pure two-leg pair without slice evidence as unmatched — the old CRITICAL stands', async () => {
    const input = await inputs();
    expect(measure(input)['hedge.funding_unmatched'].value).toBe(true);
  });

  it('drops the Boros requirement for proven floating two-leg quantity, and says so', async () => {
    const input = await withSlices(await inputs(), [twoLeg('F', '3', '3')]);
    const metrics = measure(input);
    expect(metrics['hedge.funding_unmatched'].value).toBe(false);
    expect(metrics['hedge.funding_gap_ratio'].value).toBe(0);
    expect(metrics['rollover.uncovered_funding_eth'].value).toBe(0);
    expect(JSON.stringify(metrics['hedge.funding_gap_ratio'].details)).toMatch(/intentionally floating 3 ETH \(slice F\)/);
    // Price risk is untouched: the pair still nets to zero on its own.
    expect(metrics['hedge.residual_usd'].value).toBe(0);
  });

  it('exempts only what both legs actually hold — a one-legged remainder still needs coverage', async () => {
    const input = await withSlices(await inputs(), [twoLeg('F', '3', '1')]);
    const metrics = measure(input);
    expect(metrics['hedge.funding_unmatched'].value).toBe(true);
    expect(metrics['rollover.uncovered_funding_eth'].value).toBe(4); // 2 on each leg's source
  });

  it.each([
    ['a contract that is not reconciled', { status: 'external-change' }],
    ['slice evidence older than 12 seconds', { age: 13 }],
  ])('grants nothing for %s', async (_name, opts) => {
    const input = await withSlices(await inputs(), [twoLeg('F', '3', '3')], opts);
    expect(measure(input)['hedge.funding_unmatched'].value).toBe(true);
  });

  it('grants nothing to a Boros-hedge slice — it is meant to be covered', async () => {
    const input = await withSlices(await inputs(), [twoLeg('B', '3', '3', 'boros-hedge')]);
    expect(measure(input)['hedge.funding_unmatched'].value).toBe(true);
  });

  it('refuses slice evidence that claims more than the position holds', async () => {
    const input = await withSlices(await inputs(), [twoLeg('F', '4', '4')]);
    const metrics = measure(input);
    expect(metrics['hedge.funding_unmatched'].value).toBe(true);
    expect(JSON.stringify(metrics['hedge.funding_gap_ratio'].details)).toMatch(/exceeds the held position; no exemption/);
  });

  it('checks the 0.36 a strategy hedges with Boros and explains the 3.67 that floats', async () => {
    const boros = [{ venue: 'OKX', side: 'LONG' as const, size: '0.36' }, { venue: 'HYPERLIQUID', side: 'SHORT' as const, size: '0.36' }];
    const unclaimed = await inputs({ qty: '4.03', boros });
    expect(status(unclaimed, 'hedge.hl_size_gap_eth')).toBe('CRITICAL');
    const claimed = await withSlices(await inputs({ qty: '4.03', boros }), [twoLeg('F', '3.67', '3.67')]);
    const metrics = measure(claimed);
    expect(metrics['hedge.funding_unmatched'].value).toBe(false);
    expect(metrics['hedge.funding_gap_ratio'].value).toBe(0);
    expect(status(claimed, 'hedge.hl_size_gap_eth')).toBe('OK');
  });

  it('keeps an over-covered source a gap, and says coverage is judged per source, not per strategy', async () => {
    const input = await withSlices(await inputs({ boros: [{ venue: 'OKX', side: 'LONG', size: '1' }] }), [twoLeg('F', '3', '3')]);
    const metrics = measure(input);
    expect(metrics['hedge.funding_unmatched'].value).toBe(true); // Boros on OKX with nothing left to cover
    expect(JSON.stringify(metrics['hedge.funding_gap_ratio'].details)).toMatch(/per source, not per strategy/);
  });

  it('versions the continuous-gap identity with the exemption, unchanged when there is none', async () => {
    const input = await inputs();
    const legs = input.positions.data!.exposure[0].legs;
    const plain = fundingGapFingerprint(legs, [], scope);
    expect(fundingGapFingerprint(legs, [], scope, [])).toBe(plain);
    expect(fundingGapFingerprint(legs, [], scope, [{ symbol: LONG, side: 'LONG', qty: '3' }])).not.toBe(plain);
    // tests/monitor/test_funding_applicability.py pins the monitor to this exact identity.
    expect(fundingGapFingerprint(legs, [], scope, [{ symbol: LONG, side: 'LONG', qty: '1' }, { symbol: SHORT, side: 'SHORT', qty: '1' }]))
      .toBe('["object",[["account_id",["number","0000000000000000"]],["boros",["array",[]]],["floating",["array",[["array",[["string","HYPERLIQUID_FUTURE_ETH_USDC"],["string","SHORT"],["number","3ff0000000000000"]]],["array",[["string","OKX_FUTURE_ETH_USDT"],["string","LONG"],["number","3ff0000000000000"]]]]]],["perps",["array",[["array",[["string","HYPERLIQUID_FUTURE_ETH_USDC"],["string","HYPERLIQUID"],["string","SHORT"],["number","4008000000000000"]]],["array",[["string","OKX_FUTURE_ETH_USDT"],["string","OKX"],["string","LONG"],["number","4008000000000000"]]]]]],["root",["string","0x1111111111111111111111111111111111111111"]]]]');
  });
});
