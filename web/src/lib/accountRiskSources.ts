import { readEvidence, type ReadEvidence } from '../api/client';
import { contracts, type MetricEvidence, type RiskScope } from './risk';
import { gateNumber } from './liquidation';
import type { RiskInputs } from './riskSources';
import { fx, fxStr, type Fx } from '../../../src/engine/fx';
import { formatDecimal18 } from '../../../src/core/boros/decimal18';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const number = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? gateNumber(v) : null;
const total = (xs: unknown[]) => xs.every(finite) ? xs.reduce<number>((n, x) => n + (x as number), 0) : null;
const exactDecimal = (v: unknown): Fx | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  try { return fx(String(v)); } catch { return null; }
};
const SCALE18 = 1_000_000_000_000_000_000n;
const SCALE30 = 1_000_000_000_000_000_000_000_000_000_000n;
const exact18 = (v: unknown): bigint | null => {
  if (typeof v !== 'string') return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, integer, rawFraction = ''] = m;
  const fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > 18) return null;
  const value = BigInt(integer) * SCALE18 + BigInt(fraction.padEnd(18, '0') || '0');
  return sign === '-' ? -value : value;
};
const exactPositionQty = (v: unknown) => exact18(v);
const abs18 = (v: bigint) => v < 0n ? -v : v;
const metricNumber18 = (v: bigint): number | null => {
  const n = Number(v) / Number(SCALE18);
  return Number.isFinite(n) ? n : null;
};
const metricNumber = (v: Fx) => Number(fxStr(v));
const metricNumber30 = (v: bigint): number | null => {
  const n = Number(v) / Number(SCALE30);
  return Number.isFinite(n) ? n : null;
};
const bases = ['ETH', 'BTC'] as const;
type Detail = NonNullable<MetricEvidence['details']>[number];
const priceUsd = (token: { symbol: string; priceUsd?: number | null }) => {
  if (['USDT', 'USDC'].includes(token.symbol.toUpperCase())) return 1;
  return finite(token.priceUsd) && token.priceUsd > 0 ? token.priceUsd : null;
};
const settlementPriceFx = (token: { symbol: string; priceUsd?: number | null }): Fx | null => {
  if (['USDT', 'USDC'].includes(token.symbol.toUpperCase())) return fx('1');
  return finite(token.priceUsd) && token.priceUsd > 0 ? exactDecimal(String(token.priceUsd)) : null;
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
      && poolIdentity(b.marketAcc, b.tokenId) && (exact18(b.sizeBase) ?? 0n) > 0n && finite(b.maturity) && b.venue
      && ['LONG', 'SHORT'].includes(b.side)));
  const rows = positions?.data.positions.filter(p => exactPositionQty(p.positionQty) !== 0n) ?? [];
  const exposures = positions?.data.exposure ?? [];
  const legs = exposures.flatMap(g => g.legs.map(l => ({ ...l, base: g.base })));
  const exactLegs = legs.map(p => {
    const row = rows.find(r => r.symbol === p.symbol);
    const rawQty = row ? exactPositionQty(row.positionQty) : null;
    return { ...p, qty18: rawQty === null ? null : abs18(rawQty), signedQty18: rawQty };
  });
  const perpsComplete = Boolean(positions && rows.length === legs.length
    && new Set(rows.map(p => p.symbol)).size === rows.length && new Set(legs.map(p => p.symbol)).size === legs.length
    && exactLegs.every(p => {
      const row = rows.find(r => r.symbol === p.symbol);
      const expectedQty = p.side === 'SHORT' ? -(p.qty18 ?? 0n) : p.qty18;
      const projectedQty = row ? Number(row.positionQty) : NaN;
      return bases.includes(p.base as typeof bases[number]) && p.qty18 !== null && p.qty18 > 0n
      && ['LONG', 'SHORT'].includes(p.side) && p.symbol === `${p.exchange}_FUTURE_${p.base}_${p.quote}`
      && ['USDT', 'USDC', 'USD'].includes(p.quote)
      && finite(p.qty) && p.qty > 0 && finite(projectedQty) && p.qty === Math.abs(projectedQty)
      && row !== undefined && p.signedQty18 === expectedQty;
    })
    && rows.every(p => !p.markHeldSinceMs && !p.markStaleSinceMs));
  const seenAt = Math.min(account?.time ?? now, positions?.time ?? now, asset?.time ?? now);
  const equity = account ? number(account.data.marginBalance) : null;
  const officialPnl = account && account.data.assets.length > 0 ? total(account.data.assets.map(a => number(a.upnl))) : null;
  const gatePnl = perpsComplete && account ? officialPnl ?? total(rows.map(p => number(p.upnl))) : null;
  for (const [id, value] of [['gate.equity_usd', equity], ['gate.upnl_usd', gatePnl],
    ['gate.equity_positive', equity === null ? null : equity > 0],
    ['gate.loss_equity_ratio', equity !== null && equity > 0 && gatePnl !== null ? Math.max(0, -gatePnl) / equity : null]] as const) {
    put(id, value, seenAt, Boolean(account && perpsComplete), 'Incomplete account positions / unsupported nonzero holding, or non-positive equity');
  }
  const residuals: (Fx | null)[] = [], netDetails: Detail[] = [];
  for (const base of bases) {
    const ls = exactLegs.filter(p => p.base === base);
    const net = ls.reduce((n, p) => n + (p.signedQty18 ?? 0n), 0n);
    const marks = ls.map(p => {
      const row = rows.find(r => r.symbol === p.symbol);
      return { row, price: exactDecimal(row?.markPrice) };
    });
    const selected = marks.length && marks.every(m => m.row && m.price !== null && m.price > 0n)
      ? marks.reduce((max, m) => m.price! > max.price! ? m : max) : null;
    // The largest verified mark is conservative for absolute residual USD.
    const usd = !ls.length ? 0n : selected === null ? null : abs18(net) * selected.price! / SCALE18;
    put(`hedge.perp_net_${base.toLowerCase()}`, perpsComplete ? metricNumber18(net) : null, positions?.time ?? null, perpsComplete, 'Incomplete or unsupported ETH/BTC perpetual contracts');
    residuals.push(usd);
    const markReason = selected?.row
      ? `Selected highest fresh Gate /positions markPrice ${selected.row.markPrice} from ${selected.row.symbol}${/_USDT$/.test(selected.row.symbol) ? '; USDT is valued at the fixed 1:1 USD assumption' : /_USDC$/.test(selected.row.symbol) ? '; USDC is valued at the fixed 1:1 USD assumption' : ''}; observed at ${positions?.time}`
      : ls.length ? `Missing complete fresh Gate /positions markPrice for ${base}` : `No active ${base} perpetual positions`;
    netDetails.push({ label: base, value: usd === null ? null : metricNumber(usd), unit: 'USD', reason: markReason });
  }
  const residual = perpsComplete && residuals.length === bases.length && residuals.every((v): v is Fx => v !== null)
    ? metricNumber(residuals.reduce((n, v) => n + v, 0n)) : null;
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
  const windowPools = window?.pools ?? [];
  const settlementComplete = Boolean(subject(risk) && window?.complete && finite(window.throughSec) && window.throughSec <= now
    && now - window.throughSec <= 120 && window.throughSec - window.fromSec === 86400
    && windowPools.every(p => poolIdentity(p.marketAcc, p.tokenId) && exact18(p.netToken) !== null));
  const settlementDetails: Detail[] = [], runways: Detail[] = [];
  const money: Array<bigint | null> = windowPools.map(p => {
    const amount = exact18(p.netToken);
    const token = tokens.find(t => t.tokenId === p.tokenId);
    const quote = token ? settlementPriceFx(token) : null;
    return amount === null ? null : amount === 0n ? 0n : quote !== null ? amount * quote : null;
  });
  const settlementPools = new Map<string, { marketAcc: string; tokenId: number }>();
  for (const p of pools) settlementPools.set(p.marketAcc.toLowerCase(), { marketAcc: p.marketAcc, tokenId: p.token.tokenId });
  for (const p of windowPools) settlementPools.set(p.marketAcc.toLowerCase(), { marketAcc: p.marketAcc, tokenId: p.tokenId });
  for (const pool of settlementPools.values()) {
    const token = tokens.find(t => t.tokenId === pool.tokenId);
    const collateralPool = pools.find(p => p.marketAcc.toLowerCase() === pool.marketAcc.toLowerCase());
    const symbol = token?.symbol ?? `token${pool.tokenId}`;
    const label = collateralPool ? poolLabel(collateralPool)
      : `${symbol} missing collateral pool`;
    const rawNet = windowPools.find(p => p.marketAcc.toLowerCase() === pool.marketAcc.toLowerCase())?.netToken;
    const net = rawNet === undefined ? 0n : exact18(rawNet);
    const px = token ? settlementPriceFx(token) : null;
    const usdFx30 = net === 0n ? 0n : net !== null && px !== null ? net * px : null;
    const usd = usdFx30 === null ? null : metricNumber30(usdFx30);
    const quoteReason = token && ['USDT', 'USDC'].includes(symbol.toUpperCase())
      ? `USD valuation ${usd ?? 'UNKNOWN'} uses the fixed 1:1 ${symbol} assumption; observed at ${collateral?.data.observedAt ?? 'UNKNOWN'}`
      : token && px !== null
        ? `USD valuation ${usd ?? 'UNKNOWN'} uses collateral token priceUsd ${token.priceUsd}; observed at ${collateral?.data.observedAt ?? 'UNKNOWN'}`
        : `USD valuation UNKNOWN because the collateral token priceUsd quote is missing; observed at ${collateral?.data.observedAt ?? 'UNKNOWN'}`;
    settlementDetails.push({ label, value: settlementComplete && net !== null ? formatDecimal18(net) : null, unit: symbol + '/24h', reason: quoteReason });
  }
  const allPoolIds = new Set([...pools.map(p => p.marketAcc.toLowerCase()), ...windowPools.map(p => p.marketAcc.toLowerCase())]);
  for (const acc of allPoolIds) {
    const p = pools.find(p => p.marketAcc.toLowerCase() === acc);
    const rawNet = windowPools.find(p => p.marketAcc.toLowerCase() === acc)?.netToken;
    const n = rawNet === undefined ? 0n : exact18(rawNet);
    const available = p && finite(p.availableInitialMargin) ? exactDecimal(String(p.availableInitialMargin)) : null;
    const days = n !== null && n < 0n && available !== null
      ? metricNumber(available * SCALE18 / abs18(n)) : n !== null && n >= 0n ? 'NA' : null;
    runways.push({ label: p ? poolLabel(p) : 'Missing collateral pool', value: days, unit: 'days' });
  }
  const outflows = runways.filter(d => d.value !== 'NA'), runwayComplete = settlementComplete && poolComplete && outflows.every(d => finite(d.value));
  const runway = outflows.length && outflows.every(d => finite(d.value)) ? Math.min(...outflows.map(d => d.value as number)) : null;
  put('boros.buffer_runway_days', runway, window?.throughSec ?? null, runwayComplete, 'Missing complete per-pool net outflow / available collateral', runways);
  if (settlementComplete && !runwayComplete && runway !== null) { metrics['boros.buffer_runway_days'].upperBound = true; metrics['boros.buffer_runway_days'].reason = 'Incomplete coverage'; }
  if (runwayComplete && !outflows.length) metrics['boros.buffer_runway_days'].applicability = 'NA';
  const settlementUsdExact = settlementComplete && money.every((v): v is bigint => v !== null)
    ? money.reduce((n, v) => n + v, 0n) : null;
  const settlementUsd = settlementUsdExact === null ? null : metricNumber30(settlementUsdExact);
  const settlementUsdComplete = settlementUsd !== null;
  put('boros.settlement_net_24h_usd', settlementUsd, window?.throughSec ?? null, settlementUsdComplete,
    'Missing complete signed settlement window / collateral prices', settlementDetails);
  for (const [base, tokenId] of [['eth', 2], ['btc', 1]] as const) {
    const exact = settlementComplete ? windowPools.filter(p => p.tokenId === tokenId)
      .reduce((n, p) => n + exact18(p.netToken)!, 0n) : null;
    const value = exact === null ? null : metricNumber18(exact);
    put(`boros.settlement_net_24h_${base}`, value, window?.throughSec ?? null, value !== null,
      'Missing complete signed settlement window');
  }

  const matchComplete = borosComplete && perpsComplete;
  const keys = new Set([...legs.map(p => `${p.base}:${p.exchange}:${p.side}`), ...boros.map(b => `${b.base}:${b.venue}:${b.side}`)]);
  const gaps: Detail[] = [], exactGaps = new Map<string, bigint | null>();
  for (const key of keys) {
    const [base, venue, side] = key.split(':');
    const actual = exactLegs.filter(p => p.base === base && p.exchange === venue && p.side === side)
      .reduce((n, p) => n + (p.qty18 ?? 0n), 0n);
    const fundingLegs = boros.filter(b => b.base === base && b.venue === venue && b.side === side && b.maturity! > now);
    const funding = fundingLegs.reduce<bigint | null>((n, b) => {
      const size = exact18(b.sizeBase);
      return n === null || size === null ? null : n + size;
    }, 0n);
    const gap = funding === null ? null : actual - funding;
    exactGaps.set(key, gap);
    gaps.push({ label: key, value: gap === null ? null : metricNumber18(gap), unit: base });
  }
  const mismatchedDirection = keys.size > 0 && [...keys].some(key => {
    const [base, venue, side] = key.split(':');
    const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
    return legs.some(p => p.base === base && p.exchange === venue && p.side === side)
      && boros.some(b => b.base === base && b.venue === venue && b.side === opposite && b.maturity! > now)
      && !boros.some(b => b.base === base && b.venue === venue && b.side === side && b.maturity! > now);
  });
  const quantityComplete = matchComplete && [...exactGaps.entries()].every(([key, gap]) => gap !== null
    && (key.startsWith('BTC:') ? gap === 0n : true));
  put('hedge.quantity_verified', quantityComplete ? [...exactGaps.entries()].every(([key, gap]) => gap !== null
    && (key.startsWith('BTC:') ? gap === 0n : abs18(gap) <= 1_000_000_000_000_000n)) : null,
    seenAt, quantityComplete, 'BTC funding quantity tolerance is not configured; nonzero BTC differences remain UNKNOWN', gaps);
  put('hedge.direction_match', matchComplete ? !mismatchedDirection : null, seenAt, matchComplete, 'Incomplete funding direction / quantities');
  for (const [venue, id] of [['HYPERLIQUID', 'hl'], ['BINANCE', 'binance']] as const) put(`hedge.${id}_size_gap_eth`,
    matchComplete ? metricNumber18([...exactGaps.entries()].filter(([key]) => key.startsWith(`ETH:${venue}:`))
      .reduce((max, [, gap]) => gap === null ? max : abs18(gap) > max ? abs18(gap) : max, 0n)) : null,
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
