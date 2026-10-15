import type { AccountInterest, AssetViewResponse, BorosCollateralResponse, CrossexAccount, DealAlert, DealView, OpenOrder, OpportunitiesResult, PositionsResponse } from '../api/types';
import { readEvidence, type ReadEvidence } from '../api/client';
import { gateNumber, liquidationLines } from './liquidation';
import { deriveAsset, pairMaturityProfit } from '../panels/assets/assetModel';
import { contracts, fundingGapFingerprint, scopeKey, validMetric, validateEvidence, type MetricEvidence, type RiskScope, type RiskSupplement } from './risk';
import { accountRiskMeasurements } from './accountRiskSources';

export interface RiskRead<T> { data?: T; isError?: boolean; isPending?: boolean; isPlaceholderData?: boolean }
export interface RiskInputs {
  account: RiskRead<CrossexAccount>; positions: RiskRead<PositionsResponse>; interest: RiskRead<AccountInterest>;
  collateral: RiskRead<BorosCollateralResponse>; asset: RiskRead<AssetViewResponse>; supplement: RiskRead<RiskSupplement>;
  deals: RiskRead<DealView[]>; orders: RiskRead<OpenOrder[]>; alerts: RiskRead<DealAlert[]>;
  health: RiskRead<{ status: string }>; opportunities?: RiskRead<OpportunitiesResult>;
}
const numeric = (v: unknown): number | null => (typeof v === 'string' || typeof v === 'number') ? gateNumber(v) : null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sum = (values: unknown[]): number | null => values.every(finite) ? (values as number[]).reduce((a, b) => a + b, 0) : null;
const signed = (b: { side: string; sizeToken: number }): number => b.sizeToken * (b.side === 'SHORT' ? -1 : 1);
export const BASIS_QUANTITY_TOLERANCE_ETH = 0.001;

/** Adapts shared snapshots. Domain owners keep all money/position calculations. */
export function riskMeasurements(scope: RiskScope, input: RiskInputs, now: number, historicalOnly = false,
  evidenceFor: (data: unknown) => ReadEvidence | undefined = readEvidence) {
  const metrics: Record<string, MetricEvidence> = {};
  const put = (id: string, value: unknown, source: string, observedAt: number | null, complete = true, reason?: string) => {
    metrics[id] = { value, source, observedAt, complete, reason: value === null || !complete ? reason : undefined, scope, evidence: source,
      unit: contracts[id].unit, ttlSeconds: contracts[id].max_age_seconds };
  };
  const read = <T,>(q: RiskRead<T>, ids: string[], source: string, observed?: number | null) => {
    const meta = evidenceFor(q.data);
    const sameAccount = meta?.credentialId === scope.credentialId && Boolean(scope.credentialId);
    const time = observed === undefined ? (meta?.observedAt === undefined ? null : meta.observedAt / 1000) : observed;
    const failed = (!historicalOnly && (q.isError || meta?.stale)) || q.isPlaceholderData;
    if (!sameAccount || failed || !q.data || time === null || !finite(time) || time > now) {
      for (const id of ids) put(id, null, source, time, false,
        !sameAccount ? 'Account identity not verified' : failed ? 'Read failed / stale; last success is historical' : q.isPending ? 'Loading verified evidence' : 'Missing producer observation time / source');
      return null;
    }
    return { data: q.data, observedAt: time, meta };
  };
  const gateIds = ['gate.im_coverage', 'gate.mm_health_ratio', 'gate.liability_usdt', 'gate.liability_usdc'];
  const account = read(input.account, gateIds, '/account: producer observation of upstream account snapshot');
  if (account) {
    const a = account.data;
    const balance = numeric(a.marginBalance);
    for (const [id, margin] of [['gate.im_coverage', a.initialMargin], ['gate.mm_health_ratio', a.maintenanceMargin]]) {
      const m = numeric(margin);
      put(id, balance !== null && m !== null && m > 0 ? balance / m : null, '/account: balance / margin (coverage; not MM usage)', account.observedAt,
        true, m === 0 ? 'Verified zero margin: coverage ratio is undefined' : 'Missing valid account margin');
    }
    for (const coin of ['USDT', 'USDC']) {
      const rows = a.assets?.filter(r => r.coin === coin) ?? [];
      const keys = rows.map(r => `${r.exchangeType}:${r.coin}`);
      const values = rows.map(r => numeric(r.liability));
      const valid = rows.length > 0 && new Set(keys).size === keys.length && values.every(v => v !== null && v >= 0);
      put('gate.liability_' + coin.toLowerCase(), valid ? sum(values) : null, '/account: explicit per-venue stablecoin liabilities', account.observedAt, valid,
        'Missing, negative or duplicate liability rows; absent coin is not verified zero');
    }
  }
  const interest = read(input.interest, ['gate.interest_daily_usd'], '/account/interest: existing borrowing buckets');
  if (interest && account) {
    const buckets = interest.data.buckets;
    const assets = account.data.assets;
    let complete = Array.isArray(buckets) && Array.isArray(assets) && assets.length > 0 && buckets.length === assets.length
      && ['gate.liability_usdt', 'gate.liability_usdc'].every(id => metrics[id]?.complete && finite(metrics[id].value));
    const seen = new Set<string>();
    const costs: number[] = [];
    for (const a of assets ?? []) {
      const key = `${a.exchangeType}:${a.coin}`;
      if (seen.has(key)) complete = false;
      seen.add(key);
      const debt = numeric(a.liability);
      const matches = buckets?.filter(b => b.venue === a.exchangeType && b.coin === a.coin) ?? [];
      const b = matches[0];
      if (debt === null || debt < 0 || matches.length !== 1 || !b || !finite(b.borrow) || Math.abs(b.borrow - debt) > 1e-8
        || (debt > 0 && (!['USDT', 'USDC'].includes(a.coin) || !finite(b.ratePerYear) || b.ratePerYear < 0
          || !finite(b.interestPerDayUsd) || b.interestPerDayUsd < 0))) complete = false;
      if (b) costs.push(debt === 0 ? 0 : b.interestPerDayUsd);
    }
    put('gate.interest_daily_usd', complete ? sum(costs) : null,
      '/account/interest: current USD/day estimate; existing free allowance; stablecoins valued at $1 (not an independent quote)',
      Math.min(account.observedAt, interest.observedAt), complete, 'Debt/rate buckets missing, invalid or inconsistent');
  }
  const positions = read(input.positions, ['gate.liquidation_distance_pct', 'data.age_seconds'], '/positions upstream snapshot');
  const rows = positions?.data.positions;
  const rowsValid = Array.isArray(rows) && rows.every(p => numeric(p.positionQty) !== null && typeof p.symbol === 'string');
  const eth = positions?.data.exposure.find(g => g.base === 'ETH');
  const perpLegs = eth?.legs ?? [];
  const perpsComplete = Boolean(positions && rowsValid && (rows?.filter(p => numeric(p.positionQty) !== 0).length === positions.data.exposure.reduce((n, g) => n + g.legs.length, 0))
    && perpLegs.every(p => finite(p.qty) && p.qty > 0 && ['LONG', 'SHORT'].includes(p.side)));
  if (positions && rowsValid) {
    const times = rows!.filter(p => numeric(p.positionQty) !== 0).map(p => numeric((p as typeof p & { updateTime?: string }).updateTime));
    put('data.age_seconds', times.length && times.every(t => t !== null && t / 1000 <= now)
      ? now - Math.min(...times as number[]) / 1000 : null,
      'positions.updateTime (upstream venue time; HTTP time is separate)', positions.observedAt, true,
      'No valid upstream position timestamp; verified empty positions do not supply market age');
    if (account && perpsComplete && positions.data.exposure.every(g => g.base && g.legs.every(p => finite(p.value) && p.value > 0))) {
      const lines = liquidationLines(account.data, positions.data, {}, positions.data.marginTiers ?? {});
      put('gate.liquidation_distance_pct', lines && lines.unknown.length === 0 && lines.lines.length > 0 ? Math.min(...lines.lines.map(l => Math.abs(l.move))) : null,
        'Terminal risk-tier liquidation model: one coin moves, others fixed; no future funding/interest/venue gaps; current margin-rate fallback when tiers missing',
        Math.min(account.observedAt, positions.observedAt), true, 'No finite complete conditional liquidation line');
    }
  }
  const collateralData = input.collateral.data;
  const collateral = read(input.collateral, ['boros.im_coverage', 'boros.mm_health_ratio', 'boros.available_eth'],
    '/boros/collateral: selected ETH cross-pool', collateralData?.observedAt === undefined ? null : collateralData.observedAt / 1000);
  const validCollateral = collateral && collateral.data.address.toLowerCase() === scope.address?.toLowerCase()
    && collateral.data.accountId === scope.accountId && (historicalOnly || !collateral.data.stale);
  const token = validCollateral ? collateral.data.tokens.find(t => t.tokenId === 2) : undefined;
  const pool = token?.cross;
  const expectedPool = scope.address ? `${scope.address.toLowerCase()}${(scope.accountId ?? 0).toString(16).padStart(2, '0')}0002ffffff` : '';
  const poolValid = pool?.marketAcc.toLowerCase() === expectedPool;
  if (validCollateral && poolValid && pool) {
    put('boros.im_coverage', pool.imCoverage, 'Existing collateral initial-margin coverage (no USD conversion)', collateral.observedAt,
      true, pool.initialMargin === 0 ? 'Verified zero initial margin; ratio undefined' : 'Invalid initial margin');
    put('boros.mm_health_ratio', pool.mmCoverage, 'Existing collateral maintenance-margin coverage (no USD conversion)', collateral.observedAt,
      true, pool.maintenanceMargin === 0 ? 'Verified zero maintenance margin; ratio undefined' : 'Invalid maintenance margin');
    put('boros.available_eth', pool.availableInitialMargin, 'Official availableInitialMargin; ETH cross pool only', collateral.observedAt);
  } else {
    for (const id of ['boros.im_coverage', 'boros.mm_health_ratio', 'boros.available_eth']) put(id, null, '/boros/collateral', collateral?.observedAt ?? null, false,
      validCollateral && !pool ? 'Verified no ETH cross pool; ratios and available pool balance are not applicable' : 'Wallet/subaccount/pool mismatch or failed read');
  }
  const asset = read(input.asset, ['rollover.days_to_maturity', 'boros.settlement_net_24h_eth'], '/asset-view: existing incremental ledger / current positions',
    input.asset.data?.risk?.observedAt === undefined || input.asset.data.risk.observedAt === null ? null : input.asset.data.risk.observedAt / 1000);
  const risk = asset?.data.risk;
  const assetScopeValid = Boolean(risk && risk.address.toLowerCase() === scope.address?.toLowerCase() && risk.accountId === scope.accountId && scope.accountId === 0 && (historicalOnly || !risk.stale));
  const boros = assetScopeValid ? risk!.positions : [];
  const borosComplete = Boolean(assetScopeValid && risk?.positionsComplete && boros.every(b => b.marketAcc.toLowerCase() === expectedPool && finite(b.sizeToken) && b.sizeToken > 0 && finite(b.marketId) && finite(b.maturity) && b.venue));
  const observed = asset?.observedAt ?? null;
  let days: number | null = null;
  if (borosComplete && boros.length) days = (Math.min(...boros.map(b => b.maturity!)) - now) / 86400;
  put('rollover.days_to_maturity', days, 'Complete actual ETH cross-pool positions and market maturities', observed, borosComplete,
    borosComplete && !boros.length ? 'Verified no ETH funding positions; no maturity clock' : 'Missing/partial positions or unsupported subaccount');
  const settlement = assetScopeValid ? risk!.settlement : null;
  if (settlement) {
    const t = settlement.throughSec;
    put('boros.settlement_net_24h_eth', settlement.netEth, `${settlement.reason}; (${settlement.fromSec}, ${t}]`, t, settlement.complete);
    const available = metrics['boros.available_eth'];
    const availableValid = available && !validateEvidence('boros.available_eth', available, scope, now) && finite(available.value);
    if (settlement.complete && finite(settlement.netEth) && settlement.netEth < 0 && availableValid) {
      put('boros.buffer_runway_days', Math.max(0, available.value as number) / -settlement.netEth,
        'Available same-pool ETH / past-day net outflow; historical estimate, not a forecast', Math.min(t, available.observedAt!));
    } else put('boros.buffer_runway_days', null, 'Same-pool historical outflow runway', t, false,
      settlement.complete && finite(settlement.netEth) && settlement.netEth >= 0 ? 'Verified non-outflow window: no finite outflow runway; no guaranteed survival days' : 'Missing complete net settlement or available ETH');
  }
  const supplemental = input.supplement.data && (historicalOnly || !input.supplement.isError) && scopeKey(input.supplement.data.scope) === scopeKey(scope) ? input.supplement.data : null;
  const baseline = supplemental?.baseline;
  const hl = boros.filter(b => b.venue === 'HYPERLIQUID');
  const bn = boros.filter(b => b.venue === 'BINANCE');
  const pair = borosComplete && boros.length === 2 && hl.length === 1 && bn.length === 1
    && hl[0].marketId !== bn[0].marketId ? [hl[0], bn[0]] : null;
  const actualPerps = new Map(perpLegs.map(p => [p.symbol, (p.side === 'SHORT' ? -1 : 1) * p.qty]));
  const uniquePerps = new Set(perpLegs.map(p => p.symbol)).size === perpLegs.length;
  const exactEthPerps = perpsComplete && uniquePerps && perpLegs.every(p =>
    /^(HYPERLIQUID|BINANCE)_FUTURE_ETH_(USDT|USDC|USD)$/.test(p.symbol)
    && p.symbol.startsWith(p.exchange + '_') && rows!.filter(r => r.symbol === p.symbol).length === 1
    && Math.abs(numeric(rows!.find(r => r.symbol === p.symbol)!.positionQty)!) === p.qty)
    && rows!.filter(r => numeric(r.positionQty) !== 0 && /_FUTURE_ETH_/.test(r.symbol)).every(r => actualPerps.has(r.symbol));
  put('hedge.perp_net_eth', exactEthPerps ? sum([...actualPerps.values()]) : null,
    'Complete normalized actual ETH perpetual quantities; independent of Boros and historical baseline', positions?.observedAt ?? null,
    Boolean(exactEthPerps), 'Missing complete account-matched ETH perpetual quantities or ambiguous contracts');
  for (const id of ['hedge.hl_size_gap_eth', 'hedge.binance_size_gap_eth', 'hedge.direction_match']) {
    put(id, null, 'Current ETH perpetual and Boros funding positions, matched per venue',
      positions && observed !== null ? Math.min(observed, positions.observedAt) : null, false,
      'Missing complete unique live funding pair / ETH perpetual contracts, or wallet/subaccount mismatch');
  }
  if (pair) {
    const [h, b] = pair;
    const liveMaturities = pair.every(leg => leg.maturity! > now);
    put('hedge.maturity_match', liveMaturities ? h.maturity === b.maturity : null,
      'Exact live Boros market maturities', observed, liveMaturities, 'Expired funding legs; no verified live maturity match');
    if (h.side === 'SHORT' && b.side === 'LONG' && h.maturity === b.maturity
      && [h.entryApr, h.markApr, b.entryApr, b.markApr].every(finite)) put('boros.adverse_spread_pp', ((h.markApr! - b.markApr!) - (h.entryApr! - b.entryApr!)) * 100, 'Existing asset-view mark APR spread relative to entry APR spread (percentage points)', observed);
    const mtm = sum(pair.map(p => p.mtmUsd));
    put('boros.rate_mtm_usd', mtm, 'Existing official asset-view rate MTM', observed);
    if (poolValid && pool && finite(pool.netBalance) && pool.netBalance > 0 && token && finite(token.priceUsd) && token.priceUsd > 0 && mtm !== null && collateral) put('boros.mtm_loss_equity_ratio', Math.max(0, -mtm) / (pool.netBalance * token.priceUsd), 'Negative rate MTM / same-pool equity', Math.min(observed!, collateral.observedAt));
    if (exactEthPerps && perpLegs.length === 2 && h.marketId !== b.marketId
      && pair.every(leg => leg.maturity! > now && ['LONG', 'SHORT'].includes(leg.side))
      && pair.every(leg => perpLegs.filter(p => p.exchange === leg.venue).length === 1)) {
      const matched = perpLegs.every(p => pair.some(leg => leg.venue === p.exchange && leg.side === p.side));
      put('hedge.direction_match', h.side === 'SHORT' && b.side === 'LONG' && matched, 'Complete current four-leg directions by exact venue and ETH contract', Math.min(observed!, positions!.observedAt));
      for (const [venue, id, leg] of [['HYPERLIQUID', 'hl', h], ['BINANCE', 'binance', b]] as const) {
        const ps = perpLegs.filter(p => p.exchange === venue && /^\w+_FUTURE_ETH_(USDT|USDC|USD)$/.test(p.symbol));
        if (ps.length === 1) {
          put(`hedge.${id}_size_gap_eth`, Math.abs(ps[0].qty - leg.sizeToken), 'Exact normalized perp vs corresponding Boros ETH quantity', Math.min(observed!, positions!.observedAt));
          if (ps[0].side !== leg.side) put('hedge.direction_match', false, 'Perp and funding hedge directions differ', Math.min(observed!, positions!.observedAt));
        }
      }
    }
  }
  if (baseline && borosComplete && perpsComplete && uniquePerps) {
    const borosMap = new Map(boros.map(b => [String(b.marketId), signed(b)]));
    const expectedIds = Object.keys(baseline.boros).sort();
    put('hedge.market_identity_match', JSON.stringify([...borosMap.keys()].sort()) === JSON.stringify(expectedIds)
      && JSON.stringify([...actualPerps.keys()].sort()) === JSON.stringify(Object.keys(baseline.perps).sort()), 'Explicit verified scoped baseline vs actual market IDs and contracts', Math.min(observed!, positions!.observedAt));
    const expectedSymbols = Object.keys(baseline.perps);
    const contractsExact = expectedSymbols.every(s => /^(HYPERLIQUID|BINANCE)_FUTURE_ETH_(USDT|USDC|USD)$/.test(s));
    if (contractsExact) {
      const gap = (actual: Map<string, number>, expected: Record<string, number>) => [...new Set([...actual.keys(), ...Object.keys(expected)])].reduce((n, k) => n + Math.abs((actual.get(k) ?? 0) - (expected[k] ?? 0)), 0);
      put('positions.unexpected_change_eth', gap(borosMap, baseline.boros) + gap(actualPerps, baseline.perps), 'Complete four-leg positions vs explicit scoped baseline (no inferred ADL cause)', Math.min(observed!, positions!.observedAt));
    }
  }
  put('basis.loss_profit_ratio', null, 'Four-leg pair Profit at maturity estimate (default fees)', observed, false,
    'Missing fresh scope-matched ETH positions or four-leg pair');
  if (perpsComplete && uniquePerps) {
    const h = perpLegs.filter(p => p.exchange === 'HYPERLIQUID' && /^HYPERLIQUID_FUTURE_ETH_(USDC|USDT|USD)$/.test(p.symbol));
    const b = perpLegs.filter(p => p.exchange === 'BINANCE' && /^BINANCE_FUTURE_ETH_(USDC|USDT|USD)$/.test(p.symbol));
    if (h.length === 1 && b.length === 1 && rows) {
      const hp = rows.find(p => p.symbol === h[0].symbol)!;
      const bp = rows.find(p => p.symbol === b[0].symbol)!;
      const hm = numeric(hp?.markPrice), bm = numeric(bp?.markPrice);
      const pnl = sum([numeric(hp?.upnl), numeric(bp?.upnl)]);
      put('basis.mark_spread_usd_per_eth', hm !== null && bm !== null && hm > 0 && bm > 0 && !hp?.markHeldSinceMs && !bp?.markHeldSinceMs && !hp?.markStaleSinceMs && !bp?.markStaleSinceMs ? hm - bm : null, 'Exact perpetual marks: Hyperliquid minus Binance', positions!.observedAt);
      put('basis.pnl_usd', pnl, 'Existing per-leg upstream unrealized price PnL', positions!.observedAt);
      const group = asset?.data.assets.find(g => g.base === 'ETH');
      const coverage = asset?.data.coverage;
      const close = (a: number, b: number) => Math.abs(a - b) <= BASIS_QUANTITY_TOLERANCE_ETH + 1e-12;
      let reason: string | undefined;
      if (!pair || !group || !coverage || !coverage.borosTxnsComplete || coverage.backfilling || asset!.data.warnings.length)
        reason = 'Missing complete scope-matched asset pair / fee history, or read warnings';
      else if (h[0].side !== 'SHORT' || b[0].side !== 'LONG' || pair[0].side !== 'SHORT' || pair[1].side !== 'LONG'
        || pair[0].maturity !== pair[1].maturity || pair[0].maturity! <= now)
        reason = 'Four-leg direction or live maturity mismatch';
      else if (perpLegs.length !== 2 || !close(h[0].qty, b[0].qty) || !close(pair[0].sizeToken, pair[1].sizeToken)
        || ![h[0], b[0]].every(p => pair.some(leg => leg.venue === p.exchange && close(leg.sizeToken, p.qty))))
        reason = 'Four-leg quantity difference exceeds fixed 0.001 ETH tolerance';
      else if (group.perpOpen.length !== 2 || group.borosOpen.length !== 2
        || !group.perpOpen.every(p => finite(p.feesUsd) && finite(p.imUsd) && finite(p.notionalUsd)
          && perpLegs.some(l => l.symbol === p.symbol && l.exchange === p.venue && l.side === p.side && close(l.qty, p.qty)))
        || !group.borosOpen.every(p => finite(p.settleFeeApr) && finite(p.entryApr) && finite(p.imUsd) && finite(p.notionalUsd)
          && pair.some(l => l.marketId === p.marketId && l.venue === p.venue && l.side === p.side && l.maturity === p.maturity && close(l.sizeToken, p.sizeToken)))
        || !group.borosHistory.every(p => finite(p.tradeFeeUsd)))
        reason = 'Asset-model legs differ from current positions or have missing rate / fee inputs';
      let profit: number | null = null;
      let start: number | null = null;
      if (!reason && group) {
        const model = deriveAsset(group, {}, 0, now);
        if (model.pairs.length !== 1) reason = 'Expected one unambiguous current four-leg pair';
        else {
          profit = pairMaturityProfit(model.pairs[0], now).netUsd;
          start = model.pairs[0].hedgedSinceSec;
          if (!finite(profit) || profit <= 0) reason = 'Profit at maturity estimate is unavailable or non-positive';
        }
      }
      if (pnl === null) reason = 'Missing upstream perpetual price PnL';
      const source = `Price loss / pair Profit at maturity estimate; F=${profit ?? 'UNKNOWN'} USD; ${start === null ? 'remaining term (unknown start)' : 'hedged since ' + start}; default entry fees, no exit fees; quantity tolerance 0.001 ETH`;
      put('basis.loss_profit_ratio', !reason && profit !== null && pnl !== null ? Math.max(0, -pnl) / profit : null,
        source, Math.min(observed ?? positions!.observedAt, positions!.observedAt), !reason, reason);
    }
  }
  if (borosComplete && perpsComplete && uniquePerps && (baseline || (!perpLegs.length && !boros.length))) {
    const gaps = perpLegs.map(p => {
      const coverage = boros.filter(b => b.venue === p.exchange && b.side === p.side && b.maturity! > now).reduce((n, b) => n + b.sizeToken, 0);
      return Math.max(0, p.qty - coverage);
    });
    const gap = gaps.reduce((a, b) => a + b, 0);
    put('rollover.uncovered_funding_eth', gap, 'Actual perpetual funding quantity without matching live Boros direction/venue/size', Math.min(observed!, positions!.observedAt));
    const trustedStart = supplemental?.fundingGapFingerprint === fundingGapFingerprint(perpLegs, boros, scope)
      && supplemental.fundingGapEth === gap
      && finite(supplemental.fundingGapObservedAt) && now >= supplemental.fundingGapObservedAt
      && now - supplemental.fundingGapObservedAt <= contracts['rollover.uncovered_funding_seconds'].max_age_seconds
      && finite(supplemental.fundingGapStartedAt) && supplemental.fundingGapStartedAt <= supplemental.fundingGapObservedAt ? supplemental.fundingGapStartedAt : null;
    put('rollover.uncovered_funding_seconds', gap === 0 ? 0 : trustedStart !== null ? now - trustedStart : null,
      'Verified existing collector funding-gap start (page visit never resets it)', Math.min(observed!, positions!.observedAt), true, 'Missing verified continuous funding-gap history');
  }
  if (!baseline) for (const id of ['hedge.market_identity_match', 'positions.unexpected_change_eth']) {
    put(id, null, 'Existing verified four-leg strategy baseline', observed, false, 'Missing explicit scope-matching baseline; page visit does not create one');
  }
  const deals = read(input.deals, ['execution.halted_count', 'execution.unhedged_eth', 'execution.pending_age_s'], '/deals execution projections');
  const orders = read(input.orders, [], '/orders/open upstream read');
  if (deals) {
    const complete = deals.meta?.coverageComplete === true;
    put('execution.halted_count', deals.data.filter(d => d.pair.mode === 'HALTED').length, 'Actual active HALTED deal projections', deals.observedAt, complete, 'Active deal list may be truncated');
    if (!complete) { metrics['execution.halted_count'].lowerBound = true; metrics['execution.halted_count'].reason = 'Incomplete coverage'; }
    const ethDeals = deals.data.filter(d => /^\w+_FUTURE_ETH_(USDT|USDC|USD)$/.test(d.pair.a.contract) || /^\w+_FUTURE_ETH_(USDT|USDC|USD)$/.test(d.pair.b?.contract ?? ''));
    const quantities = ethDeals.map(d => numeric(d.projection?.unhedged));
    const quantityComplete = complete && quantities.every(finite);
    put('execution.unhedged_eth', quantityComplete ? sum(quantities.map(q => Math.abs(q!))) : quantities.some(finite) ? sum(quantities.filter(finite).map(Math.abs)) : null,
      'Explicit ETH execution unhedged projections', deals.observedAt, quantityComplete, 'Incomplete or missing execution projection');
    if (!quantityComplete && finite(metrics['execution.unhedged_eth'].value)) { metrics['execution.unhedged_eth'].lowerBound = true; metrics['execution.unhedged_eth'].reason = 'Incomplete coverage'; }
    const pending = deals.data.flatMap(d => d.orders.filter(o => o.state === 'PENDING' || o.quarantinedStatus !== null));
    const reportsComplete = deals.data.every(d => d.projection && typeof d.projection.anyPending === 'boolean' && typeof d.projection.anyQuarantined === 'boolean');
    const realPending = deals.data.some(d => d.projection?.anyPending || d.projection?.anyQuarantined);
    const times = pending.map(o => o.createdAt / 1000);
    const openTimes = orders?.data.map(o => numeric(o.createTime)) ?? [];
    const ordersComplete = Boolean(orders && openTimes.every(t => t !== null && t / 1000 <= now));
    const ages = [...times.map(t => now - t), ...openTimes.map(t => now - t! / 1000)];
    const agesComplete = complete && reportsComplete && ordersComplete && (!realPending || pending.length > 0) && ages.every(a => finite(a) && a >= 0);
    const knownAges = ages.filter(a => finite(a) && a >= 0);
    put('execution.pending_age_s', agesComplete ? ages.length ? Math.max(...ages) : 0 : knownAges.length ? Math.max(...knownAges) : null,
      'Actual pending/quarantined/open order creation time (not page time)', Math.min(deals.observedAt, orders?.observedAt ?? deals.observedAt), agesComplete);
    if (!agesComplete && knownAges.length) { metrics['execution.pending_age_s'].lowerBound = true; metrics['execution.pending_age_s'].reason = 'Incomplete coverage'; }
  }
  const health = read(input.health, ['service.http_ok'], '/health: terminal HTTP only');
  if (health) put('service.http_ok', health.data.status === 'ok', 'Terminal HTTP availability; independent collector status shown separately', health.observedAt);
  else if (input.health.isError) put('service.http_ok', false, 'Terminal HTTP read failed', now);
  const sourcesFailed = Object.values(input).some(q => q && q.isError);
  const markedStale = Object.values(input).some(q => q && evidenceFor(q.data)?.stale)
    || Boolean(rows?.some(p => p.markHeldSinceMs || p.markStaleSinceMs)) || Boolean(risk?.stale || collateralData?.stale);
  put('data.stale', sourcesFailed || markedStale, 'Existing query failures and upstream stale/held marks', now, true);
  const complete = Boolean(account && perpsComplete && borosComplete && settlement?.complete && asset?.data.coverage.borosTxnsComplete && !asset.data.coverage.backfilling && asset.data.warnings.length === 0);
  put('data.coverage_complete', complete, 'Complete account/positions/selected-pool settlement/history evidence', now);
  const quote = input.opportunities;
  if (quote?.data && !quote.isError && !quote.isPlaceholderData && pair && days !== null && days < 14 && token && finite(token.priceUsd)) {
    const q = quote.data;
    const size = pair[0].sizeToken * token.priceUsd;
    const quoteRead = evidenceFor(q);
    const scopeMatches = quoteRead?.credentialId === scope.credentialId && !quoteRead.stale && finite(quoteRead.observedAt);
    if (scopeMatches && baseline && perpsComplete && uniquePerps && perpLegs.length === 2
      && pair[0].side === 'SHORT' && pair[1].side === 'LONG' && pair[0].sizeToken === pair[1].sizeToken
      && pair.every(b => baseline.boros[String(b.marketId)] === signed(b))
      && perpLegs.every(p => baseline.perps[p.symbol] === (p.side === 'SHORT' ? -p.qty : p.qty))
      && perpLegs.every(p => pair.some(b => b.venue === p.exchange && b.side === p.side && b.sizeToken === p.qty))
      && Math.abs(q.meta.notionalUsd - size) < .01 && q.meta.exitMode === 'roll' && q.meta.borosEntry === 'market') {
      const candidates = q.groups.filter(g => g.tokenId === 2 && g.underlying === 'ETH' && g.maturity > Math.max(...pair.map(b => b.maturity!)))
        .flatMap(g => g.pairs.filter(p => p.base === 'ETH' && p.shortLeg.venue.toUpperCase() === 'HYPERLIQUID' && p.longLeg.venue.toUpperCase() === 'BINANCE'
          && p.shortLeg.crossexSymbol === perpLegs.find(l => l.exchange === 'HYPERLIQUID')?.symbol && p.longLeg.crossexSymbol === perpLegs.find(l => l.exchange === 'BINANCE')?.symbol
          ).map(p => ({ g, p })));
      candidates.sort((a, b) => (b.p.netFixedApr ?? -Infinity) - (a.p.netFixedApr ?? -Infinity));
      const candidate = candidates[0];
      if (candidate) {
        const statuses = new Map(candidate.g.markets.map(m => [m.marketId, m.bookStatus]));
        put('rollover.next_net_apr', q.warnings.some(w => w.includes('fees assume')) ? null : candidate.p.netFixedApr, 'Existing actual-size later-maturity quote, APR on notional', quoteRead!.observedAt! / 1000);
        const books = candidate.p.borosLegs.map(l => statuses.get(l.marketId));
        put('rollover.depth_coverage_ratio', books.length > 0 && books.every(s => s === 'ok') ? 1 : books.some(s => s === 'insufficient-depth') ? 0 : null, 'Existing actual-size executable book coverage', quoteRead!.observedAt! / 1000);
      }
    }
  }
  if (supplemental) {
    for (const [id, e] of Object.entries(supplemental.metrics)) {
      const current = metrics[id];
      if (!contracts[id]) continue;
      // This estimate belongs to the current shared pair model, not legacy collector baselines.
      if (id === 'basis.loss_profit_ratio') continue;
      const measuredBound = current?.lowerBound && !validateEvidence(id, { ...current, complete: true }, scope, now);
      if (!measuredBound && (!current || validateEvidence(id, current, scope, now))) metrics[id] = e;
    }
  }
  for (const coin of ['usdt', 'usdc']) {
    const quote = metrics[`stablecoin.${coin}_usd`];
    if (quote && !validateEvidence(`stablecoin.${coin}_usd`, quote, scope, now)) put(`stablecoin.${coin}_deviation`, Math.abs(quote.value as number - 1), quote.source, quote.observedAt);
  }
  const quotes = ['usdt', 'usdc'].map(c => metrics[`stablecoin.${c}_usd`]);
  if (quotes.every(q => q && finite(q.value))) put('stablecoin.source_age_s', Math.max(...quotes.map(q => now - q.observedAt!)), 'Independent USD quote producer times', Math.min(...quotes.map(q => q.observedAt!)));
  for (const group of ['custody', 'protocol']) {
    const e = metrics[`${group}.incident_status`];
    if (e && !validateEvidence(`${group}.incident_status`, e, scope, now)) put(`${group}.review_age_h`, (now - e.observedAt!) / 3600, e.source, e.observedAt);
  }
  const accountAdapted = scope.pool === 'account' ? accountRiskMeasurements(scope, input, now, evidenceFor, historicalOnly) : null;
  if (accountAdapted) Object.assign(metrics, accountAdapted.metrics);
  if (!historicalOnly && (sourcesFailed || markedStale)) {
    const historical = riskMeasurements(scope, input, now, true).metrics;
    for (const [id, entry] of Object.entries(historical)) {
      const current = metrics[id];
      const measuredBound = current?.lowerBound && !validateEvidence(id, { ...current, complete: true }, scope, now);
      if (validMetric(entry.value, contracts[id]) && !measuredBound && (!current || validateEvidence(id, current, scope, now))) {
        metrics[id] = { ...entry, ...current, value: null, complete: false, historicalValue: entry.value,
          reason: current?.reason ?? 'Read failed / stale; cached shared snapshot is historical only' };
      }
    }
  }
  return { metrics, pauseRollover: accountAdapted?.pauseRollover ?? (borosComplete && days !== null && days >= 14),
    boros: accountAdapted?.boros ?? boros, days: accountAdapted?.days ?? days };
}
