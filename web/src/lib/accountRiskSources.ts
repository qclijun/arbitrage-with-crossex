import { readEvidence, type ReadEvidence } from '../api/client';
import { contracts, type MetricEvidence, type RiskScope } from './risk';
import { gateNumber } from './liquidation';
import type { RiskInputs } from './riskSources';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const number = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? gateNumber(v) : null;
const total = (xs: unknown[]) => xs.every(finite) ? xs.reduce<number>((n, x) => n + (x as number), 0) : null;
const bases = ['ETH', 'BTC'] as const;
type Detail = NonNullable<MetricEvidence['details']>[number];
const priceUsd = (token: { symbol: string; priceUsd?: number | null }) => {
  if (['USDT', 'USDC'].includes(token.symbol.toUpperCase())) return 1;
  return finite(token.priceUsd) && token.priceUsd > 0 ? token.priceUsd : null;
};

/** Account estimates never assign an aggregate venue position's PnL to a pair. */
export function accountRiskMeasurements(scope: RiskScope, input: RiskInputs, now: number,
  evidenceFor: (data: unknown) => ReadEvidence | undefined = readEvidence, historicalOnly = false) {
  const metrics: Record<string, MetricEvidence> = {};
  const put = (id: string, value: unknown, observedAt: number | null, complete: boolean, reason: string, details?: Detail[]) => {
    const source = 'Complete ETH/BTC account snapshots; independent Boros collateral pools';
    metrics[id] = { value, observedAt, complete, reason: complete && value !== null ? undefined : reason,
      source, evidence: source, scope, unit: contracts[id].unit, ttlSeconds: contracts[id].max_age_seconds, details };
  };
  const read = <T,>(q: { data?: T; isError?: boolean; isPlaceholderData?: boolean }, observed?: number | null) => {
    const meta = evidenceFor(q.data), time = observed === undefined ? (meta?.observedAt ?? NaN) / 1000 : observed;
    return q.data && !q.isPlaceholderData && (historicalOnly || (!q.isError && !meta?.stale))
      && meta?.credentialId === scope.credentialId && finite(time) && time <= now && now - time <= 120
      ? { data: q.data, time } : null;
  };
  const account = read(input.account), positions = read(input.positions);
  const asset = read(input.asset, input.asset.data?.risk?.observedAt == null ? null : input.asset.data.risk.observedAt / 1000);
  const collateral = read(input.collateral, input.collateral.data?.observedAt == null ? null : input.collateral.data.observedAt / 1000);
  const risk = asset?.data.risk;
  const subject = (d: { address: string; accountId: number; stale: boolean } | undefined) => Boolean(d
    && d.address.toLowerCase() === scope.address?.toLowerCase() && d.accountId === scope.accountId && (historicalOnly || !d.stale));
  const prefix = scope.address?.toLowerCase() + (scope.accountId ?? 0).toString(16).padStart(2, '0');
  const poolIdentity = (acc: string, tokenId: number) => /^0x[a-f0-9]{52}$/.test(acc.toLowerCase())
    && acc.toLowerCase().startsWith(prefix + tokenId.toString(16).padStart(4, '0'));
  const boros = subject(risk) ? risk!.positions : [];
  const borosComplete = Boolean(subject(risk) && risk?.version === 2 && risk.positionsComplete
    && new Set(boros.map(b => `${b.marketAcc}:${b.marketId}`)).size === boros.length
    && boros.every(b => bases.includes(b.base as typeof bases[number]) && b.tokenId !== undefined
      && poolIdentity(b.marketAcc, b.tokenId) && finite(b.sizeBase) && b.sizeBase > 0 && finite(b.maturity) && b.venue
      && ['LONG', 'SHORT'].includes(b.side)));
  const rows = positions?.data.positions.filter(p => number(p.positionQty) !== 0) ?? [];
  const exposures = positions?.data.exposure ?? [];
  const legs = exposures.flatMap(g => g.legs.map(l => ({ ...l, base: g.base })));
  const perpsComplete = Boolean(positions && rows.length === legs.length
    && new Set(rows.map(p => p.symbol)).size === rows.length && new Set(legs.map(p => p.symbol)).size === legs.length
    && legs.every(p => bases.includes(p.base as typeof bases[number]) && finite(p.qty) && p.qty > 0
      && ['LONG', 'SHORT'].includes(p.side) && p.symbol === `${p.exchange}_FUTURE_${p.base}_${p.quote}`
      && ['USDT', 'USDC', 'USD'].includes(p.quote)
      && rows.some(r => r.symbol === p.symbol && number(r.positionQty) === (p.side === 'SHORT' ? -p.qty : p.qty)))
    && rows.every(p => !p.markHeldSinceMs && !p.markStaleSinceMs));
  const seenAt = Math.min(account?.time ?? now, positions?.time ?? now, asset?.time ?? now);
  const equity = account ? number(account.data.marginBalance) : null;
  const officialPnl = account ? total(account.data.assets.map(a => number(a.upnl))) : null;
  const gatePnl = perpsComplete && account ? officialPnl ?? total(rows.map(p => number(p.upnl))) : null;
  for (const [id, value] of [['gate.equity_usd', equity], ['gate.upnl_usd', gatePnl],
    ['gate.equity_positive', equity === null ? null : equity > 0],
    ['gate.loss_equity_ratio', equity !== null && equity > 0 && gatePnl !== null ? Math.max(0, -gatePnl) / equity : null]] as const) {
    put(id, value, seenAt, Boolean(account && perpsComplete), 'Incomplete account positions / unsupported nonzero holding, or non-positive equity');
  }
  const residuals: number[] = [], netDetails: Detail[] = [];
  for (const base of bases) {
    const ls = legs.filter(p => p.base === base);
    const net = ls.reduce((n, p) => n + (p.side === 'SHORT' ? -p.qty : p.qty), 0);
    const prices = ls.map(p => number(rows.find(r => r.symbol === p.symbol)?.markPrice));
    const px = prices.length && prices.every(p => finite(p) && p > 0) ? Math.max(...prices as number[]) : null;
    // The largest verified mark is conservative for absolute residual USD.
    const usd = !ls.length ? 0 : px === null ? null : Math.abs(net) * px;
    put(`hedge.perp_net_${base.toLowerCase()}`, perpsComplete ? net : null, positions?.time ?? null, perpsComplete, 'Incomplete or unsupported ETH/BTC perpetual contracts');
    if (usd !== null) residuals.push(usd);
    netDetails.push({ label: base, value: usd, unit: 'USD' });
  }
  const residual = perpsComplete && residuals.length === bases.length ? total(residuals) : null;
  put('hedge.residual_usd', residual, seenAt, perpsComplete, 'Missing complete per-asset marks / quantities', netDetails);
  put('hedge.residual_equity_ratio', residual !== null && equity !== null && equity > 0 ? residual / equity : null, seenAt,
    perpsComplete && Boolean(account), 'Missing complete marks / positive Gate equity');

  const tokens = subject(collateral?.data) ? collateral!.data.tokens : [];
  const pools = tokens.flatMap(t => [...(t.cross ? [t.cross] : []), ...t.isolated].map(p => ({ ...p, token: t })));
  const poolComplete = Boolean(subject(collateral?.data) && new Set(pools.map(p => p.marketAcc.toLowerCase())).size === pools.length
    && pools.every(p => poolIdentity(p.marketAcc, p.token.tokenId) && finite(p.netBalance) && finite(p.initialMargin)
      && p.initialMargin >= 0 && finite(p.maintenanceMargin) && p.maintenanceMargin >= 0 && finite(p.availableInitialMargin)
      && finite(p.activePositions) && (p.netBalance === 0 && p.activePositions === 0 || priceUsd(p.token) !== null)));
  const balances = pools.map(p => {
    const px = priceUsd(p.token);
    return p.netBalance === 0 ? 0 : finite(p.netBalance) && px !== null ? p.netBalance * px : null;
  });
  const borosEquity = poolComplete ? total(balances) : null;
  const borosPnl = borosComplete ? total(boros.map(b => b.mtmUsd)) : null;
  const poolLabel = (p: typeof pools[number]) => `${p.token.symbol} ${p.marketAcc.endsWith('ffffff') ? 'cross' : 'isolated ' + parseInt(p.marketAcc.slice(-6), 16)}`;
  put('boros.equity_usd', borosEquity, collateral?.time ?? null, poolComplete, 'Missing complete priced collateral pools');
  put('boros.equity_positive', borosEquity === null ? null : borosEquity > 0, collateral?.time ?? null, poolComplete, 'Missing complete collateral equity');
  put('boros.rate_mtm_usd', borosPnl, asset?.time ?? null, borosComplete, 'Missing complete ETH/BTC account rate MTM');
  put('boros.mtm_loss_equity_ratio', borosPnl !== null && borosEquity !== null && borosEquity > 0 ? Math.max(0, -borosPnl) / borosEquity : null,
    Math.min(asset?.time ?? now, collateral?.time ?? now), borosComplete && poolComplete, 'Missing complete MTM / positive account equity');
  for (const [id, key] of [['boros.im_coverage', 'initialMargin'], ['boros.mm_health_ratio', 'maintenanceMargin']] as const) {
    const ds = pools.map(p => ({ label: poolLabel(p), value: finite(p.netBalance) && finite(p[key]) && p[key]! > 0 ? p.netBalance / p[key]! : null, unit: 'ratio' }));
    const applicable = ds.filter((_, i) => pools[i][key] !== 0);
    const values = applicable.map(d => d.value).filter(finite);
    put(id, values.length ? Math.min(...values) : null, collateral?.time ?? null, poolComplete && applicable.length === values.length,
      applicable.length ? 'Incomplete independent margin pools' : 'Verified no posted margin; ratio undefined', ds);
    if (!metrics[id].complete && values.length) { metrics[id].upperBound = true; metrics[id].reason = 'Incomplete coverage'; }
  }
  put('boros.pool_available_nonnegative', poolComplete ? pools.every(p => p.availableInitialMargin! >= 0 && (p.activePositions === 0 || p.netBalance! > 0)) : null,
    collateral?.time ?? null, poolComplete, 'Incomplete independent collateral pools', pools.map(p => ({ label: poolLabel(p), value: p.availableInitialMargin, unit: p.token.symbol })));

  const window = risk?.settlements;
  const settlementComplete = Boolean(subject(risk) && window?.complete && finite(window.throughSec) && window.throughSec <= now
    && now - window.throughSec <= 120 && window.throughSec - window.fromSec === 86400
    && window.pools.every(p => poolIdentity(p.marketAcc, p.tokenId) && finite(p.netToken)));
  const settlementDetails: Detail[] = [], runways: Detail[] = [];
  const money: unknown[] = [];
  for (const p of window?.pools ?? []) {
    const token = tokens.find(t => t.tokenId === p.tokenId);
    const px = token ? priceUsd(token) : null;
    money.push(p.netToken === 0 ? 0 : finite(p.netToken) && px !== null ? p.netToken * px : null);
  }
  const settlementPools = new Map<string, { marketAcc: string; tokenId: number }>();
  for (const p of pools) settlementPools.set(p.marketAcc.toLowerCase(), { marketAcc: p.marketAcc, tokenId: p.token.tokenId });
  for (const p of window?.pools ?? []) settlementPools.set(p.marketAcc.toLowerCase(), { marketAcc: p.marketAcc, tokenId: p.tokenId });
  for (const pool of settlementPools.values()) {
    const token = tokens.find(t => t.tokenId === pool.tokenId);
    const collateralPool = pools.find(p => p.marketAcc.toLowerCase() === pool.marketAcc.toLowerCase());
    const symbol = token?.symbol ?? `token${pool.tokenId}`;
    const label = collateralPool ? poolLabel(collateralPool)
      : `${symbol} missing collateral pool ${pool.marketAcc}`;
    const net = window?.pools.find(p => p.marketAcc.toLowerCase() === pool.marketAcc.toLowerCase())?.netToken ?? 0;
    settlementDetails.push({ label, value: settlementComplete ? net : null, unit: symbol + '/24h' });
  }
  const allPoolIds = new Set([...pools.map(p => p.marketAcc.toLowerCase()), ...(window?.pools ?? []).map(p => p.marketAcc.toLowerCase())]);
  for (const acc of allPoolIds) {
    const p = pools.find(p => p.marketAcc.toLowerCase() === acc), n = window?.pools.find(p => p.marketAcc.toLowerCase() === acc)?.netToken ?? 0;
    const days = n < 0 && p && finite(p.availableInitialMargin) ? Math.max(0, p.availableInitialMargin) / -n : n >= 0 ? 'NA' : null;
    runways.push({ label: p ? poolLabel(p) : 'Missing collateral pool', value: days, unit: 'days' });
  }
  const outflows = runways.filter(d => d.value !== 'NA'), runwayComplete = settlementComplete && poolComplete && outflows.every(d => finite(d.value));
  const runway = outflows.length && outflows.every(d => finite(d.value)) ? Math.min(...outflows.map(d => d.value as number)) : null;
  put('boros.buffer_runway_days', runway, window?.throughSec ?? null, runwayComplete, 'Missing complete per-pool net outflow / available collateral', runways);
  if (settlementComplete && !runwayComplete && runway !== null) { metrics['boros.buffer_runway_days'].upperBound = true; metrics['boros.buffer_runway_days'].reason = 'Incomplete coverage'; }
  if (runwayComplete && !outflows.length) metrics['boros.buffer_runway_days'].applicability = 'NA';
  const settlementUsdComplete = settlementComplete && money.every(finite);
  put('boros.settlement_net_24h_usd', settlementUsdComplete ? total(money) : null, window?.throughSec ?? null, settlementUsdComplete,
    'Missing complete signed settlement window / collateral prices', settlementDetails);
  for (const [base, tokenId] of [['eth', 2], ['btc', 1]] as const) put(`boros.settlement_net_24h_${base}`,
    settlementComplete ? window!.pools.filter(p => p.tokenId === tokenId).reduce((n, p) => n + p.netToken, 0) : null,
    window?.throughSec ?? null, settlementComplete, 'Missing complete signed settlement window');

  const matchComplete = borosComplete && perpsComplete;
  const keys = new Set([...legs.map(p => `${p.base}:${p.exchange}:${p.side}`), ...boros.map(b => `${b.base}:${b.venue}:${b.side}`)]);
  const gaps: Detail[] = [];
  for (const key of keys) {
    const [base, venue, side] = key.split(':');
    const actual = legs.filter(p => p.base === base && p.exchange === venue && p.side === side).reduce((n, p) => n + p.qty, 0);
    const funding = boros.filter(b => b.base === base && b.venue === venue && b.side === side && b.maturity! > now).reduce((n, b) => n + (b.sizeBase ?? NaN), 0);
    gaps.push({ label: key, value: finite(funding) ? actual - funding : null, unit: base });
  }
  const mismatchedDirection = keys.size > 0 && [...keys].some(key => {
    const [base, venue, side] = key.split(':');
    const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
    return legs.some(p => p.base === base && p.exchange === venue && p.side === side)
      && boros.some(b => b.base === base && b.venue === venue && b.side === opposite && b.maturity! > now)
      && !boros.some(b => b.base === base && b.venue === venue && b.side === side && b.maturity! > now);
  });
  const quantityComplete = matchComplete && gaps.every(d => finite(d.value))
    && !gaps.some(d => d.unit === 'BTC' && Math.abs(d.value as number) > 1e-12);
  put('hedge.quantity_verified', quantityComplete ? gaps.every(d => Math.abs(d.value as number) <= (d.unit === 'ETH' ? .001 : 1e-12)) : null,
    seenAt, quantityComplete, 'BTC funding quantity tolerance is not configured; nonzero BTC differences remain UNKNOWN', gaps);
  put('hedge.direction_match', matchComplete ? !mismatchedDirection : null, seenAt, matchComplete, 'Incomplete funding direction / quantities');
  for (const [venue, id] of [['HYPERLIQUID', 'hl'], ['BINANCE', 'binance']] as const) put(`hedge.${id}_size_gap_eth`,
    matchComplete ? Math.max(0, ...gaps.filter(d => d.label.startsWith(`ETH:${venue}:`)).map(d => Math.abs(d.value as number))) : null,
    seenAt, matchComplete, 'Incomplete funding quantities', gaps);
  const maturityMatch = boros.every(b => b.maturity! > now);
  put('hedge.maturity_match', borosComplete ? maturityMatch : null, asset?.time ?? null, borosComplete, 'Incomplete live funding maturities');
  const days = borosComplete && boros.length ? (Math.min(...boros.map(b => b.maturity!)) - now) / 86400 : null;
  put('rollover.days_to_maturity', days, asset?.time ?? null, borosComplete, 'Missing complete live maturities; empty account has no maturity clock');
  const complete = Boolean(account && perpsComplete && borosComplete && poolComplete && settlementComplete
    && settlementUsdComplete && borosPnl !== null && borosEquity !== null && gatePnl !== null && residual !== null);
  put('data.coverage_complete', complete, seenAt, true, 'Incomplete ETH/BTC account / collateral pool evidence');
  return { metrics, boros, days, pauseRollover: borosComplete && days !== null && days >= 14 };
}
