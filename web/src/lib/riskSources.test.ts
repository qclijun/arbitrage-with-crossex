import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../api/client';
import { contracts, evaluateRisk, fundingGapFingerprint, type RiskScope } from './risk';
import { riskMeasurements, type RiskInputs } from './riskSources';
import { deriveAsset, pairMaturityProfit } from '../panels/assets/assetModel';

const now = 1800000000;
const address = '0x' + '1'.repeat(40);
const pool = address + '000002ffffff';
const scope: RiskScope = { credentialId: 'fixture', address, accountId: 0, pool: 'ETH-cross' };
async function snapshot<T>(data: T, coverageComplete = true) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data,
    meta: { ts: now * 1000, observedAt: now * 1000, credentialId: scope.credentialId, coverageComplete } }))));
  return { data: await fetchJson<T>('/synthetic-risk-fixture') };
}
async function fixture() {
  const boros = ['HYPERLIQUID', 'BINANCE'].map((venue, i) => ({ marketAcc: pool, marketId: 128 + i, venue,
    maturity: now + 10 * 86400, side: i ? 'LONG' : 'SHORT', sizeToken: 3,
    entryApr: i ? .04 : .12, markApr: i ? .04 : .15, mtmUsd: -2, mtmUsdExact: '-2', notionalUsd: 9000, settleFeeApr: .001,
    base: 'ETH', tokenId: 2, sizeBase: '3' }));
  const legs = ['HYPERLIQUID', 'BINANCE'].map((exchange, i) => ({ symbol: exchange + '_FUTURE_ETH_' + (i ? 'USDT' : 'USDC'),
    exchange, base: 'ETH', quote: i ? 'USDT' : 'USDC', side: i ? 'LONG' : 'SHORT', qty: 3, value: 9000 }));
  const rows = legs.map((p, i) => ({ symbol: p.symbol, positionQty: i ? '3' : '-3', markPrice: '3000', upnl: '-1', updateTime: String(now * 1000) }));
  const assets = [{ coin: 'USDT', exchangeType: 'BINANCE', liability: '10' }, { coin: 'USDC', exchangeType: 'HYPERLIQUID', liability: '0' }];
  const input = {
    account: await snapshot({ marginBalance: '200', initialMargin: '100', maintenanceMargin: '60', assets }),
    interest: await snapshot({ buckets: [{ coin: 'USDT', venue: 'BINANCE', borrow: 10, ratePerYear: .1752, interestPerDayUsd: .0048 },
      { coin: 'USDC', venue: 'HYPERLIQUID', borrow: 0, ratePerYear: null, interestPerDayUsd: 0 }] }),
    positions: await snapshot({ positions: rows, exposure: [{ base: 'ETH', legs }] }),
    collateral: await snapshot({ address, accountId: 0, observedAt: now * 1000, stale: false, tokens: [{ symbol: 'ETH', tokenId: 2, priceUsd: 3000,
      cross: { marketAcc: pool, netBalance: .1, netBalanceExact: '0.1', initialMargin: .04, maintenanceMargin: .02, availableInitialMargin: .04, imCoverage: 2.5, mmCoverage: 5 }, isolated: [] }] }),
    asset: await snapshot({ assets: [], warnings: [], coverage: { borosPositionsComplete: true, borosTxnsComplete: true, backfilling: false },
      risk: { version: 2, address, accountId: 0, observedAt: now * 1000, stale: false, positionsComplete: true, positions: boros,
        settlement: { netEth: -.01, complete: true, fromSec: now - 86400, throughSec: now, reason: 'complete net ledger' } } }),
    supplement: await snapshot({ scope, metrics: {}, baseline: { boros: { '128': -3, '129': 3 }, perps: Object.fromEntries(legs.map(p => [p.symbol, p.side === 'SHORT' ? -3 : 3])),
      opened_at: now - 86400, observed_at: now - 100, evidence: 'explicit verified baseline' }, fundingGapStartedAt: null, reason: '' }),
    deals: await snapshot([]), orders: await snapshot([]), alerts: await snapshot([]), health: await snapshot({ status: 'ok' }),
  };
  return input as unknown as RiskInputs;
}
const check = (input: RiskInputs, id: string, selectedScope = scope) => evaluateRisk(selectedScope, riskMeasurements(selectedScope, input, now).metrics, now).checks.find(c => c.id === id)!;
async function basisFixture() {
  const input = await fixture();
  input.supplement.data!.baseline = null;
  const risk = input.asset.data!.risk!;
  for (const leg of risk.positions) leg.sizeToken = 3.0001309;
  input.asset.data!.assets = [{ base: 'ETH', supported: true, priceUsd: 3000, earliestSec: now - 86400,
    perpOpen: input.positions.data!.exposure[0].legs.map(p => ({ symbol: p.symbol, venue: p.exchange,
      side: p.side, qty: p.qty, notionalUsd: 9000, entryPrice: 3000, markPrice: 3000, leverage: 20,
      upnlUsd: -1, fundingUsd: 0, feesUsd: 1, imUsd: 100, openedAt: now - 86400 })),
    perpClosed: [], borosOpen: risk.positions.map(p => ({ ...p, collateral: 'ETH', imUsd: 50, settleUsd: 0 })),
    borosHistory: risk.positions.map(p => ({ marketId: p.marketId, venue: p.venue, maturity: p.maturity,
      firstEventSec: now - 86400, settleUsd: 0, settleFeeUsd: 0, tradePnlUsd: 0, tradeFeeUsd: 1 })),
  }] as unknown as NonNullable<RiskInputs['asset']['data']>['assets'];
  return input;
}
afterEach(() => vi.unstubAllGlobals());

describe('Risk shared-snapshot acceptance', () => {
  it('sums Gate and Boros account PnL from exact decimal strings', async () => {
    const input = await fixture(), accountScope: RiskScope = { ...scope, pool: 'account' };
    input.account.data!.assets[0].upnl = '0.1';
    input.account.data!.assets[1].upnl = '0.2';
    input.asset.data!.risk!.positions[0].mtmUsd = 900;
    input.asset.data!.risk!.positions[0].mtmUsdExact = '-0.1';
    input.asset.data!.risk!.positions[1].mtmUsd = 900;
    input.asset.data!.risk!.positions[1].mtmUsdExact = '-0.2';
    const metrics = riskMeasurements(accountScope, input, now).metrics;
    expect(metrics['gate.upnl_usd']).toMatchObject({ value: 0.3, complete: true });
    expect(metrics['boros.rate_mtm_usd'].value).toBe(-0.3);
  });

  it('sums Gate account PnL beyond 12 decimals without losing the exact residue', async () => {
    const input = await fixture(), accountScope: RiskScope = { ...scope, pool: 'account' };
    input.account.data!.assets[0].upnl = '123.00000000000000000001';
    input.account.data!.assets[1].upnl = '-123.00000000000000000002';
    const metric = riskMeasurements(accountScope, input, now).metrics['gate.upnl_usd'];
    expect(metric).toMatchObject({ value: -1e-20, complete: true });
  });

  it('keeps Gate account PnL unknown when its account field is invalid', async () => {
    const input = await fixture(), accountScope: RiskScope = { ...scope, pool: 'account' };
    input.account.data!.assets[0].upnl = 'invalid';
    const metric = riskMeasurements(accountScope, input, now).metrics['gate.upnl_usd'];
    expect(metric).toMatchObject({ value: null, complete: false });
  });

  it('sums Boros collateral equity with fixed point arithmetic', async () => {
    const input = await fixture(), accountScope: RiskScope = { ...scope, pool: 'account' };
    const token = input.collateral.data!.tokens[0];
    token.priceUsd = 1;
    token.cross!.netBalance = .1;
    token.cross!.netBalanceExact = '0.100000000000000001';
    token.cross!.activePositions = 0;
    token.isolated = [{ ...token.cross!, marketAcc: address + '000002000001', netBalance: .2, netBalanceExact: '0.2' }];
    const metric = riskMeasurements(accountScope, input, now).metrics['boros.equity_usd'];
    expect(metric).toMatchObject({ value: .3, complete: true });
  });

  it('keeps valid 18-decimal collateral equity complete', async () => {
    const input = await fixture(), accountScope: RiskScope = { ...scope, pool: 'account' };
    const token = input.collateral.data!.tokens[0];
    token.priceUsd = 1;
    token.cross!.netBalance = .12345678901234568;
    token.cross!.netBalanceExact = '0.123456789012345678';
    token.cross!.activePositions = 0;
    const metric = riskMeasurements(accountScope, input, now).metrics['boros.equity_usd'];
    expect(metric).toMatchObject({ value: .12345678901234568, complete: true });
  });

  it('keeps Boros equity unknown when exact collateral balance evidence is absent', async () => {
    const input = await fixture(), accountScope: RiskScope = { ...scope, pool: 'account' };
    input.collateral.data!.tokens[0].cross!.netBalanceExact = null;
    const metric = riskMeasurements(accountScope, input, now).metrics['boros.equity_usd'];
    expect(metric).toMatchObject({ value: null, complete: false });
  });

  it('measures actual ETH perp neutrality without a baseline or Boros read', async () => {
    const input = await fixture();
    input.supplement.data!.baseline = null;
    input.asset.isError = true;
    input.positions.data!.exposure[0].legs[1].qty = 3.02;
    input.positions.data!.positions[1].positionQty = '3.02';
    const c = check(input, 'hedge.perp_net_eth');
    expect(c.metrics['hedge.perp_net_eth'].value).toBeCloseTo(.02);
    expect(c.status).toBe('CRITICAL');
    expect(check(input, 'positions.unexpected_change_eth').status).toBe('UNKNOWN');
  });
  it('matches actual funding legs without accepting a historical baseline', async () => {
    const input = await basisFixture();
    const c = check(input, 'hedge.hl_size_gap_eth');
    expect(c.status).toBe('OK');
    expect(c.metrics['hedge.hl_size_gap_eth'].value).toBeCloseTo(.0001309, 7);
    expect(c.metrics['hedge.binance_size_gap_eth'].value).toBeCloseTo(.0001309, 7);
    expect(c.metrics['hedge.direction_match'].value).toBe(true);
    input.asset.data!.risk!.positions[0].side = 'LONG';
    expect(check(input, 'hedge.hl_size_gap_eth').status).toBe('CRITICAL');
  });
  it('reports actual maturity separately from unverified historical market identity', async () => {
    const input = await fixture();
    input.supplement.data!.baseline = null;
    expect(check(input, 'hedge.maturity_match').status).toBe('OK');
    expect(check(input, 'hedge.market_identity_match').status).toBe('UNKNOWN');
    input.asset.data!.risk!.positions[0].maturity! += 86400;
    expect(check(input, 'hedge.maturity_match').status).toBe('CRITICAL');
    expect(check(input, 'hedge.market_identity_match').status).toBe('UNKNOWN');
  });
  it('keeps matching expired funding maturities UNKNOWN', async () => {
    const input = await fixture();
    input.supplement.data!.baseline = null;
    input.asset.data!.risk!.positions.forEach(p => { p.maturity = now - 1; });
    expect(check(input, 'hedge.maturity_match').status).toBe('UNKNOWN');
  });
  it('keeps current direction matching independent of a different historical contract', async () => {
    const input = await fixture();
    input.supplement.data!.baseline!.perps = { HYPERLIQUID_FUTURE_ETH_USDT: -3, BINANCE_FUTURE_ETH_USDT: 3 };
    expect(check(input, 'hedge.hl_size_gap_eth').status).toBe('OK');
    expect(check(input, 'hedge.market_identity_match').status).toBe('CRITICAL');
    expect(check(input, 'positions.unexpected_change_eth').status).toBe('CRITICAL');
  });
  it('accepts normalized hedge-mode shorts whose upstream quantity is positive', async () => {
    const input = await fixture();
    input.supplement.data!.baseline = null;
    input.positions.data!.positions[0].positionQty = '3';
    input.positions.data!.positions[0].positionSide = 'SHORT';
    expect(check(input, 'hedge.perp_net_eth').status).toBe('OK');
    expect(check(input, 'hedge.hl_size_gap_eth').status).toBe('OK');
  });
  it.each(['failed', 'foreign', 'partial', 'wallet', 'expired', 'duplicate-market', 'duplicate-contract', 'wrong-venue', 'wrong-quantity'] as const)(
    'keeps current funding checks UNKNOWN for %s evidence without a baseline', async kind => {
      const input = await fixture();
      input.supplement.data!.baseline = null;
      if (kind === 'failed') input.positions.isError = true;
      if (kind === 'partial') input.asset.data!.risk!.positionsComplete = false;
      if (kind === 'wallet') input.asset.data!.risk!.address = '0x' + '2'.repeat(40);
      if (kind === 'expired') input.asset.data!.risk!.positions[0].maturity = now - 1;
      if (kind === 'duplicate-market') input.asset.data!.risk!.positions[1].marketId = 128;
      if (kind === 'duplicate-contract') input.positions.data!.exposure[0].legs.push(input.positions.data!.exposure[0].legs[0]);
      if (kind === 'wrong-venue') input.positions.data!.exposure[0].legs[0].exchange = 'BINANCE';
      if (kind === 'wrong-quantity') input.positions.data!.exposure[0].legs[0].qty = 2;
      const selectedScope = kind === 'foreign' ? { ...scope, credentialId: 'different-account' } : scope;
      expect(check(input, 'hedge.hl_size_gap_eth', selectedScope).status).toBe('UNKNOWN');
      if (kind === 'duplicate-market') expect(check(input, 'hedge.maturity_match').status).toBe('UNKNOWN');
    });
  it('uses pair Profit at maturity without baseline for a small actual quantity difference', async () => {
    const input = await basisFixture();
    const group = input.asset.data!.assets[0];
    const pair = deriveAsset(group, {}, 0, now).pairs[0];
    const profit = pairMaturityProfit(pair, now).netUsd!;
    expect(profit).toBeGreaterThan(0);
    const c = check(input, 'basis.mark_spread_usd_per_eth');
    expect(c.metrics['basis.loss_profit_ratio'].value).toBeCloseTo(2 / profit);
    expect(c.status).not.toBe('UNKNOWN');
    input.positions.data!.positions[0].upnl = '5';
    expect(check(input, 'basis.mark_spread_usd_per_eth').metrics['basis.loss_profit_ratio'].value).toBe(0);
  });
  it.each(['quantity', 'direction', 'maturity', 'partial', 'stale', 'scope', 'fee', 'rate', 'non-positive', 'missing-pnl'] as const)(
    'keeps unusable maturity-profit estimates UNKNOWN: %s', async kind => {
      const input = await basisFixture();
      const risk = input.asset.data!.risk!;
      const group = input.asset.data!.assets[0];
      if (kind === 'quantity') risk.positions[0].sizeToken += .002;
      if (kind === 'direction') risk.positions[0].side = 'LONG';
      if (kind === 'maturity') risk.positions[0].maturity! += 86400;
      if (kind === 'partial') risk.positionsComplete = false;
      if (kind === 'stale') risk.stale = true;
      if (kind === 'scope') risk.address = '0x' + '2'.repeat(40);
      if (kind === 'fee') group.perpOpen[0].feesUsd = NaN;
      if (kind === 'rate') group.borosOpen[0].entryApr = null;
      if (kind === 'non-positive') group.perpOpen[0].feesUsd = 10000;
      if (kind === 'missing-pnl') input.positions.data!.positions[0].upnl = '';
      const metric = check(input, 'basis.mark_spread_usd_per_eth').metrics['basis.loss_profit_ratio'];
      expect(metric.value).toBeNull();
      expect(metric.reason).toBeTruthy();
    });
  it('falls back to a remaining-term estimate when opening times are unknown', async () => {
    const input = await basisFixture();
    const group = input.asset.data!.assets[0];
    for (const p of group.perpOpen) p.openedAt = null;
    for (const p of group.borosHistory) p.firstEventSec = undefined;
    const metric = check(input, 'basis.mark_spread_usd_per_eth').metrics['basis.loss_profit_ratio'];
    expect(metric.value).not.toBeNull();
    expect(metric.evidence).toContain('remaining term');
  });
  it.each([.001, .001001])('enforces the inclusive fixed quantity boundary: %s ETH', async gap => {
    const input = await basisFixture();
    const group = input.asset.data!.assets[0];
    for (const p of input.asset.data!.risk!.positions) p.sizeToken = 3 + gap;
    for (const p of group.borosOpen) { p.sizeToken = 3 + gap; p.notionalUsd = p.sizeToken * 3000; }
    const metric = check(input, 'basis.mark_spread_usd_per_eth').metrics['basis.loss_profit_ratio'];
    expect(metric.value === null).toBe(gap > .001);
  });
  it('does not replace a failed current estimate with a legacy collector ratio', async () => {
    const input = await fixture();
    input.supplement.data!.metrics['basis.loss_profit_ratio'] = { value: 0, unit: 'ratio', scope,
      observedAt: now, ttlSeconds: 120, complete: true, source: 'legacy collector', evidence: 'old baseline model' };
    expect(check(input, 'basis.mark_spread_usd_per_eth').metrics['basis.loss_profit_ratio'].value).toBeNull();
  });
  it.each(['missing', 'different-quantity'] as const)('uses entry APR as the spread baseline with %s strategy configuration', async kind => {
    const input = await fixture();
    if (kind === 'missing') input.supplement.data!.baseline = null;
    else input.supplement.data!.baseline!.boros['128'] = -4;
    const c = check(input, 'boros.adverse_spread_pp');
    expect(c.metrics['boros.adverse_spread_pp'].value).toBeCloseTo(3);
    expect(c.status).not.toBe('UNKNOWN');
  });
  it.each(['entry-apr', 'mark-apr', 'direction', 'maturity', 'partial', 'stale', 'account', 'wallet', 'expired'] as const)('keeps unverified spread inputs UNKNOWN: %s', async kind => {
    const input = await fixture();
    input.supplement.data!.baseline = null;
    const risk = input.asset.data!.risk!;
    if (kind === 'entry-apr') risk.positions[0].entryApr = null;
    if (kind === 'mark-apr') risk.positions[1].markApr = null;
    if (kind === 'direction') risk.positions[0].side = 'LONG';
    if (kind === 'maturity') risk.positions[1].maturity! += 86400;
    if (kind === 'partial') risk.positionsComplete = false;
    if (kind === 'stale') risk.stale = true;
    if (kind === 'account') risk.accountId = 1;
    if (kind === 'wallet') risk.address = '0x' + '2'.repeat(40);
    if (kind === 'expired') risk.observedAt = (now - contracts['boros.adverse_spread_pp'].max_age_seconds - 1) * 1000;
    expect(check(input, 'boros.adverse_spread_pp').status).toBe('UNKNOWN');
  });
  it('retains normalized quantities without prices, and distinguishes funding gaps from price-neutral exposure', async () => {
    const input = await fixture();
    input.positions.data!.positions[0].markPrice = '';
    input.asset.data!.risk!.positions[0].sizeToken = 2;
    const m = riskMeasurements(scope, input, now).metrics;
    expect(m['hedge.perp_net_eth'].value).toBe(0);
    expect(m['hedge.hl_size_gap_eth'].value).toBe(1);
    expect(m['rollover.uncovered_funding_eth'].value).toBe(1);
    expect(m['rollover.uncovered_funding_seconds'].value).toBeNull();
    expect(m['basis.mark_spread_usd_per_eth'].value).toBeNull();
    expect(check(input, 'rollover.uncovered_funding_seconds').status).toBe('WARNING');
  });
  it.each(['no-price', 'zero-margin', 'no-pool', 'wrong-pool', 'partial-positions', 'failed'] as const)('keeps collateral evidence independent and scoped: %s', async kind => {
    const input = await fixture();
    const token = input.collateral.data!.tokens[0];
    if (kind === 'no-price') token.priceUsd = null;
    if (kind === 'zero-margin') { token.cross!.initialMargin = 0; token.cross!.imCoverage = null; }
    if (kind === 'no-pool') token.cross = null;
    if (kind === 'wrong-pool') token.cross!.marketAcc = '0x' + '2'.repeat(40) + '000002ffffff';
    if (kind === 'partial-positions') input.asset.data!.risk!.positionsComplete = false;
    if (kind === 'failed') input.collateral.isError = true;
    const c = check(input, 'boros.im_coverage');
    expect(c.status).toBe(['no-price', 'partial-positions'].includes(kind) ? 'OK' : 'UNKNOWN');
    if (kind === 'failed') expect(c.metrics['boros.im_coverage'].historicalValue).toBe(2.5);
    if (kind === 'no-pool') expect(c.reason).toContain('no ETH cross pool');
  });
  it.each([0, .01, null])('keeps non-outflow or incomplete settlement %s free of a sentinel runway', async net => {
    const input = await fixture(); input.asset.data!.risk!.settlement.netEth = net;
    const c = check(input, 'boros.settlement_net_24h_eth');
    expect(c.status).toBe('UNKNOWN');
    expect(c.metrics['boros.buffer_runway_days']?.value ?? null).toBeNull();
    if (net !== null) expect(c.reason).toContain('no finite outflow runway');
  });
  it.each(['direction', 'quantity', 'market', 'maturity', 'contract'] as const)('locates a %s mismatch', async kind => {
    const input = await fixture();
    if (kind === 'direction') input.asset.data!.risk!.positions[0].side = 'LONG';
    if (kind === 'quantity') input.asset.data!.risk!.positions[0].sizeToken = 2;
    if (kind === 'market') input.asset.data!.risk!.positions[0].marketId = 130;
    if (kind === 'maturity') input.asset.data!.risk!.positions[0].maturity! += 86400;
    if (kind === 'contract') {
      input.positions.data!.exposure[0].legs[0].symbol = 'HYPERLIQUID_FUTURE_ETH_USDT';
      input.positions.data!.positions[0].symbol = 'HYPERLIQUID_FUTURE_ETH_USDT';
    }
    const id = kind === 'direction' || kind === 'quantity' ? 'hedge.hl_size_gap_eth'
      : kind === 'maturity' ? 'hedge.maturity_match' : 'hedge.market_identity_match';
    expect(check(input, id).status).toBe('CRITICAL');
    if (kind !== 'maturity') expect(check(input, 'positions.unexpected_change_eth').status).toBe('CRITICAL');
  });
  it.each(['baseline', 'partial', 'subaccount'] as const)('rejects unverified %s without inferring empty positions', async kind => {
    const input = await fixture();
    if (kind === 'baseline') input.supplement.data!.baseline = null;
    if (kind === 'partial') input.asset.data!.risk!.positionsComplete = false;
    const s = kind === 'subaccount' ? { ...scope, accountId: 1 } : scope;
    expect(check(input, 'positions.unexpected_change_eth', s).status).toBe('UNKNOWN');
    expect(check(input, 'hedge.perp_net_eth', s).status).toBe('OK');
    if (kind !== 'baseline') expect(check(input, 'rollover.days_to_maturity', s).status).toBe('UNKNOWN');
    expect(riskMeasurements(s, input, now).pauseRollover).toBe(false);
  });
  it.each([14, 14 - 1 / 86400, 0, -1])('uses actual %s-day maturity and exact pause boundary', async days => {
    const input = await fixture();
    input.asset.data!.risk!.positions.forEach(p => { p.maturity = now + days * 86400; });
    expect(riskMeasurements(scope, input, now).pauseRollover).toBe(days >= 14);
    expect(check(input, 'rollover.days_to_maturity').metrics['rollover.days_to_maturity'].value).toBeCloseTo(days);
  });
  it('accepts only continuous history for the current exact funding gap', async () => {
    const input = await fixture();
    input.asset.data!.risk!.positions[0].sizeToken = 2;
    input.supplement.data!.fundingGapStartedAt = now - 200;
    input.supplement.data!.fundingGapObservedAt = now;
    input.supplement.data!.fundingGapEth = 1;
    expect(riskMeasurements(scope, input, now).metrics['rollover.uncovered_funding_seconds'].value).toBeNull();
    input.supplement.data!.fundingGapFingerprint = fundingGapFingerprint(input.positions.data!.exposure[0].legs, input.asset.data!.risk!.positions, scope);
    expect(riskMeasurements(scope, input, now).metrics['rollover.uncovered_funding_seconds'].value).toBe(200);
    input.asset.data!.risk!.positions[0].sizeToken = 1;
    expect(riskMeasurements(scope, input, now).metrics['rollover.uncovered_funding_seconds'].value).toBeNull();
  });
  it('rejects a formerly smaller gap duration when the same static book crosses maturity', async () => {
    const input = await fixture();
    input.asset.data!.risk!.positions[0].sizeToken = 2;
    input.asset.data!.risk!.positions[0].maturity = now - 1;
    input.supplement.data!.fundingGapStartedAt = now - 200;
    input.supplement.data!.fundingGapObservedAt = now - 10;
    input.supplement.data!.fundingGapEth = 1;
    input.supplement.data!.fundingGapFingerprint = fundingGapFingerprint(input.positions.data!.exposure[0].legs, input.asset.data!.risk!.positions, scope);
    const m = riskMeasurements(scope, input, now).metrics;
    expect(m['rollover.uncovered_funding_eth'].value).toBe(3);
    expect(m['rollover.uncovered_funding_seconds'].value).toBeNull();
  });
  it.each(['zero', 'absent-coin', 'missing-debt', 'negative', 'duplicate', 'missing-rate', 'negative-rate', 'bucket-mismatch', 'failed'] as const)('validates borrowing %s', async kind => {
    const input = await fixture();
    const assets = input.account.data!.assets!;
    const buckets = input.interest.data!.buckets!;
    if (kind === 'zero') { assets[0].liability = '0'; buckets[0].borrow = 0; buckets[0].ratePerYear = null; }
    if (kind === 'absent-coin') { assets.pop(); buckets.pop(); }
    if (kind === 'missing-debt') assets[0].liability = '';
    if (kind === 'negative') assets[0].liability = '-1';
    if (kind === 'duplicate') assets.push(assets[0]);
    if (kind === 'missing-rate') buckets[0].ratePerYear = null;
    if (kind === 'negative-rate') buckets[0].ratePerYear = -1;
    if (kind === 'bucket-mismatch') buckets[0].venue = 'OKX';
    if (kind === 'failed') input.interest.isError = true;
    const m = riskMeasurements(scope, input, now).metrics;
    expect(m['gate.interest_daily_usd']?.value).toBe(kind === 'zero' ? 0 : null);
    expect(m['gate.im_coverage'].value).toBe(2);
    if (kind === 'failed') expect(m['gate.liability_usdt'].value).toBe(10);
  });
  it('keeps a prior shared snapshot historical when Risk first opens after its failure', async () => {
    const input = await fixture(); input.account.isError = true;
    expect(check(input, 'gate.im_coverage')).toMatchObject({ status: 'UNKNOWN', metrics: { 'gate.im_coverage': { value: null, historicalValue: 2 } } });
  });
  it('keeps valid automatic evidence ahead of a newer manual safe value', async () => {
    const input = await fixture(); input.account.data!.marginBalance = '90';
    input.supplement.data!.metrics['gate.im_coverage'] = { value: 5, unit: 'ratio', scope, observedAt: now,
      complete: true, ttlSeconds: 3600, source: 'manual', evidence: 'review' };
    expect(check(input, 'gate.im_coverage').status).toBe('CRITICAL');
  });
  it('accepts complete zero residuals but partial or missing projections never establish OK', async () => {
    const input = await fixture(); expect(check(input, 'execution.unhedged_eth').status).toBe('OK');
    input.deals = await snapshot([{ pair: { mode: 'HALTED', a: { contract: 'BINANCE_FUTURE_ETH_USDT' } }, projection: { unhedged: .5, anyPending: true, anyQuarantined: true },
      orders: [{ state: 'PENDING', quarantinedStatus: 'unknown', createdAt: (now - 1000) * 1000 }] }], false) as unknown as RiskInputs['deals'];
    const c = check(input, 'execution.unhedged_eth');
    expect(c).toMatchObject({ status: 'CRITICAL', coverageComplete: false });
    expect(c.metrics['execution.unhedged_eth']).toMatchObject({ value: .5, lowerBound: true });
    expect(c.metrics['execution.pending_age_s']).toMatchObject({ value: 1000, lowerBound: true });
    input.supplement.data!.metrics['execution.unhedged_eth'] = { value: 0, unit: 'ETH', scope, observedAt: now,
      complete: true, ttlSeconds: 3600, source: 'manual zero', evidence: 'fixture' };
    expect(check(input, 'execution.unhedged_eth')).toMatchObject({ status: 'CRITICAL', coverageComplete: false });
    input.supplement.data!.metrics = {};
    input.deals = await snapshot([{ pair: { mode: 'RUNNING', a: { contract: 'BINANCE_FUTURE_ETH_USDT' } }, orders: [] }]) as unknown as RiskInputs['deals'];
    expect(check(input, 'execution.unhedged_eth').status).toBe('UNKNOWN');
  });
  it.each(['valid', 'spread', 'empty-boros', 'missing-book', 'venue', 'symbol', 'size', 'maturity', 'depth', 'fees', 'unequal-legs', 'direction', 'baseline-market'] as const)('requires an actual-size matching later rollover quote: %s', async kind => {
    const input = await fixture();
    const quote = { meta: { notionalUsd: 9000, exitMode: 'roll', borosEntry: 'market' }, warnings: kind === 'fees' ? ['fees assume tier'] : [],
      groups: [{ tokenId: 2, underlying: 'ETH', maturity: now + 30 * 86400,
        markets: [{ marketId: 130, bookStatus: kind === 'depth' ? 'insufficient-depth' : 'ok' }, { marketId: 131, bookStatus: 'ok' }],
        pairs: [{ base: 'ETH', netFixedApr: .04, shortLeg: { venue: 'HYPERLIQUID', crossexSymbol: 'HYPERLIQUID_FUTURE_ETH_USDC' },
          longLeg: { venue: 'BINANCE', crossexSymbol: 'BINANCE_FUTURE_ETH_USDT' },
          borosLegs: [{ marketId: 130, side: 'SHORT' }, { marketId: 131, side: 'LONG' }] }] }] };
    if (kind === 'spread') quote.groups[0].pairs[0].borosLegs.pop();
    if (kind === 'empty-boros') quote.groups[0].pairs[0].borosLegs.length = 0;
    if (kind === 'missing-book') quote.groups[0].markets.pop();
    if (kind === 'venue') quote.groups[0].pairs[0].shortLeg.venue = 'OKX';
    if (kind === 'symbol') quote.groups[0].pairs[0].shortLeg.crossexSymbol = 'HYPERLIQUID_FUTURE_ETH_USDT';
    if (kind === 'size') quote.meta.notionalUsd = 10000;
    if (kind === 'maturity') quote.groups[0].maturity = now + 86400;
    if (kind === 'unequal-legs') {
      input.asset.data!.risk!.positions[1].sizeToken = 4;
      input.positions.data!.exposure[0].legs[1].qty = 4;
      input.positions.data!.positions[1].positionQty = '4';
    }
    if (kind === 'direction') {
      input.asset.data!.risk!.positions[0].side = 'LONG';
      input.positions.data!.exposure[0].legs[0].side = 'LONG';
    }
    if (kind === 'baseline-market') input.asset.data!.risk!.positions[0].marketId = 132;
    input.opportunities = await snapshot(quote) as unknown as RiskInputs['opportunities'];
    const c = check(input, 'rollover.next_net_apr');
    expect(c.status).toBe(kind === 'valid' || kind === 'spread' ? 'OK' : kind === 'depth' ? 'WARNING' : 'UNKNOWN');
    expect(check(input, 'rollover.incremental_margin_usd').status).toBe('UNKNOWN');
  });
  it('accepts valid reviewed evidence for every enabled metric and retains every missing check', async () => {
    const input = await basisFixture();
    const ids = new Set(evaluateRisk(scope, {}, now).checks.flatMap(c => Object.keys(c.metrics)));
    for (const id of ids) {
      const contract = contracts[id];
      const value = contract.type === 'bool' ? true : contract.type === 'enum' ? contract.values![0] : contract.unit === 'unix seconds' ? now - 1 : 1;
      input.supplement.data!.metrics[id] = { value, unit: contract.unit, scope, observedAt: now, ttlSeconds: contract.max_age_seconds,
        complete: true, source: 'synthetic reviewed source', evidence: 'fixture' };
    }
    expect(evaluateRisk(scope, riskMeasurements(scope, input, now).metrics, now).checks.every(c => c.coverageComplete)).toBe(true);
    expect(evaluateRisk(scope, {}, now).checks.every(c => c.status === 'UNKNOWN')).toBe(true);
  });
});
