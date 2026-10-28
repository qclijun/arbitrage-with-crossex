import { readEvidence, type ReadEvidence } from '../api/client';
import { contracts, FUNDING_GAP_MIN_USD, fundingGapFingerprint, fundingQuantityVerified, materialBorosLeg, MIN_ORDER_VALUE_USD, scopeKey, type MetricEvidence, type RiskScope } from './risk';
import { gateNumber } from './liquidation';
import type { RiskInputs } from './riskSources';
import { floatingApplicability, SLICE_EVIDENCE_MAX_AGE_SECONDS } from './fundingApplicability';
import { fx, fxStr, type Fx } from '../../../src/engine/fx';
import { formatDecimal18, parseDecimal18 } from '../../../src/core/boros/decimal18';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const number = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? gateNumber(v) : null;
const totalAccountPnl = (values: unknown[]): number | null => {
  const decimals = values.map(value => {
    if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isFinite(value))) return null;
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
    if (!match) return null;
    const fraction = match[3] ?? '';
    if (fraction.length > 36) return null;
    const scale = fraction.length;
    const magnitude = BigInt(match[2]) * 10n ** BigInt(scale) + BigInt(fraction || '0');
    return { coefficient: match[1] === '-' ? -magnitude : magnitude, scale };
  });
  if (!decimals.length || decimals.some(value => value === null)) return null;
  const parts = decimals as Array<{ coefficient: bigint; scale: number }>;
  const scale = Math.max(...parts.map(value => value.scale));
  const sum = parts.reduce((total, value) => total + value.coefficient * 10n ** BigInt(scale - value.scale), 0n);
  const result = Number(sum) / 10 ** scale;
  return Number.isFinite(result) ? result : null;
};
const exactDecimal = (v: unknown): Fx | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  try { return fx(String(v)); } catch { return null; }
};
const SCALE18 = 1_000_000_000_000_000_000n;
const SCALE30 = 1_000_000_000_000_000_000_000_000_000_000n;
const exact18 = parseDecimal18;
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
  const officialPnl = account && account.data.assets.length > 0 ? totalAccountPnl(account.data.assets.map(a => a.upnl)) : null;
  const gatePnl = perpsComplete && account ? officialPnl : null;
  const gateEvidenceComplete = Boolean(account && perpsComplete);
  const gatePnlComplete = gateEvidenceComplete && officialPnl !== null;
  put('gate.equity_usd', equity, seenAt, gateEvidenceComplete, 'Incomplete account positions / unsupported nonzero holding, or non-positive equity');
  put('gate.upnl_usd', gatePnl, seenAt, gatePnlComplete, 'Missing or invalid account unrealized PnL / incomplete positions');
  put('gate.equity_positive', equity === null ? null : equity > 0, seenAt, gateEvidenceComplete,
    'Incomplete account positions / unsupported nonzero holding, or non-positive equity');
  put('gate.loss_equity_ratio', equity !== null && equity > 0 && gatePnl !== null ? Math.max(0, -gatePnl) / equity : null,
    seenAt, gatePnlComplete, 'Missing account PnL / positive equity or incomplete positions');
  const residuals: (Fx | null)[] = [], netDetails: Detail[] = [];
  const fundingPrices = new Map<string, Fx | null>();
  for (const base of bases) {
    const ls = exactLegs.filter(p => p.base === base);
    const net = ls.reduce((n, p) => n + (p.signedQty18 ?? 0n), 0n);
    const marks = ls.map(p => {
      const row = rows.find(r => r.symbol === p.symbol);
      return { row, price: exactDecimal(row?.markPrice) };
    });
    const selected = marks.length && marks.every(m => m.row && m.price !== null && m.price > 0n)
      ? marks.reduce((max, m) => m.price! > max.price! ? m : max) : null;
    const collateralQuote = collateral?.data.tokens.find(t => t.symbol === base)?.priceUsd;
    fundingPrices.set(base, selected?.price ?? (!ls.length && finite(collateralQuote) && collateralQuote > 0
      ? exactDecimal(String(collateralQuote)) : null));
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
    && pools.every(p => {
      const balance = exact18(p.netBalanceExact);
      return poolIdentity(p.marketAcc, p.token.tokenId) && balance !== null && finite(p.netBalance) && finite(p.initialMargin)
        && p.initialMargin >= 0 && finite(p.maintenanceMargin) && p.maintenanceMargin >= 0 && finite(p.availableInitialMargin)
        && finite(p.activePositions) && (balance === 0n && p.activePositions === 0 || priceUsd(p.token) !== null);
    }));
  const balances = pools.map(p => {
    const amount18 = exact18(p.netBalanceExact);
    const px = amount18 === 0n ? fx('0') : settlementPriceFx(p.token);
    return amount18 !== null && px !== null ? amount18 * px : null;
  });
  const equity30 = poolComplete && balances.every((value): value is bigint => value !== null)
    ? balances.reduce((sum, value) => sum + value, 0n) : null;
  const borosEquity = equity30 === null ? null : metricNumber30(equity30);
  const borosPnlExact = borosComplete ? boros.reduce<bigint | null>((sum, position) => {
    const amount = exact18(position.mtmUsdExact);
    return amount === null || sum === null ? null : sum + amount;
  }, 0n) : null;
  const borosPnl = borosPnlExact === null ? null : metricNumber18(borosPnlExact);
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
    // Boros collateral uses token precision, not the engine's 12-place scale.
    const available = p && finite(p.availableInitialMargin) ? exact18(String(p.availableInitialMargin)) : null;
    const days = n !== null && n < 0n && available !== null
      ? metricNumber18(available * SCALE18 / abs18(n)) : n !== null && n >= 0n ? 'NA' : null;
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

  const fundingSourcesComplete = boros.every(b => b.spreadVenues == null
    ? Boolean(b.venue && /^[A-Z0-9]+$/.test(b.venue))
    : b.spreadVenues.length === 2 && b.spreadVenues.every(v => /^[A-Z0-9]+$/.test(v))
      && b.spreadVenues[0] !== b.spreadVenues[1]);
  // Spread funding is venue 1 minus venue 2. Keep each market once for
  // collateral/PnL/maturity, and expand only its funding coverage.
  const fundingSources = boros.flatMap(b => b.spreadVenues?.length === 2
    ? [{ ...b, venue: b.spreadVenues[0] }, { ...b, venue: b.spreadVenues[1],
      side: b.side === 'SHORT' ? 'LONG' as const : 'SHORT' as const }]
    : [b]);
  const matchComplete = borosComplete && perpsComplete && fundingSourcesComplete;
  // Proven floating two-leg quantity needs no Boros (fundingApplicability.ts).
  const sliceRead = read(input.slices ?? {});
  const floating = floatingApplicability(sliceRead && now - sliceRead.time <= SLICE_EVIDENCE_MAX_AGE_SECONDS ? sliceRead.data : null, exactLegs);
  const keys = new Set([...legs.map(p => `${p.base}:${p.exchange}:${p.side}`), ...fundingSources.map(b => `${b.base}:${b.venue}:${b.side}`)]);
  const gaps: Detail[] = [], ratios: Detail[] = [], dollars: Detail[] = [], exactGaps = new Map<string, bigint | null>();
  let maxRatio = 0, maxMaterialRatio = 0, maxGapUsd = 0n, pricesComplete = true, unmatched = false;
  for (const key of keys) {
    const [base, venue, side] = key.split(':');
    const actual = exactLegs.filter(p => p.base === base && p.exchange === venue && p.side === side)
      .reduce((n, p) => n + (p.qty18 ?? 0n), 0n);
    const fundingLegs = fundingSources.filter(b => b.base === base && b.venue === venue && b.side === side && b.maturity! > now);
    const funding = fundingLegs.reduce<bigint | null>((n, b) => {
      const size = exact18(b.sizeBase);
      return n === null || size === null ? null : n + size;
    }, 0n);
    const required = actual - (floating.byKey.get(key) ?? 0n);
    const gap = funding === null ? null : required - funding;
    exactGaps.set(key, gap);
    gaps.push({ label: key, value: gap === null ? null : metricNumber18(gap), unit: base });
    if (gap === null) continue;
    const ratio = required > 0n ? Number(abs18(gap)) / Number(required) : funding! > 0n ? 1 : 0;
    if (ratio > maxRatio) maxRatio = ratio;
    // A missing side is an independent danger, including tiny orphan positions.
    unmatched ||= required === 0n && funding! > 0n || required > 0n && funding === 0n;
    const price = fundingPrices.get(base);
    const gapUsd = gap === 0n ? 0n : price === null || price === undefined ? null : abs18(gap) * price;
    if (gapUsd === null) pricesComplete = false;
    else if (gapUsd > maxGapUsd) maxGapUsd = gapUsd;
    const sourceLegs = exactLegs.filter(p => p.base === base && p.exchange === venue && p.side === side);
    const steps = sourceLegs.map(p => {
      const rule = positions?.data.quantitySteps?.[p.symbol];
      const step = rule && finite(rule.observedAt) && rule.observedAt <= now * 1000 && now * 1000 - rule.observedAt <= 600_000
        ? exact18(rule.lotSize) : null;
      return step !== null && step > 0n && p.qty18 !== null && p.qty18 % step === 0n ? step : null;
    });
    const step = steps.length && steps.every((v): v is bigint => v !== null) ? steps.reduce((n, v) => n + v, 0n) : null;
    const material = gapUsd !== null && gapUsd > BigInt(FUNDING_GAP_MIN_USD) * SCALE30
      && (step === null || abs18(gap) > step);
    if (material && ratio > maxMaterialRatio) maxMaterialRatio = ratio;
    ratios.push({ label: key, value: finite(ratio) ? ratio : null, unit: 'ratio',
      reason: `Perpetual ${formatDecimal18(actual)} ${base}${floating.notes.has(key) ? `; ${floating.notes.get(key)}` : ''}; Boros ${formatDecimal18(funding!)} ${base}; signed gap ${formatDecimal18(gap)} ${base}; ${(ratio * 100).toFixed(6)}%; verified executable lot ${step === null ? 'unavailable (no lot exemption)' : formatDecimal18(step) + ' ' + base}; minimum gap $${FUNDING_GAP_MIN_USD}; material ${material}; coverage judged per source, not per strategy` });
    dollars.push({ label: key, value: gapUsd === null ? null : metricNumber30(gapUsd), unit: 'USD' });
  }
  const mismatchedDirection = keys.size > 0 && [...keys].some(key => {
    const [base, venue, side] = key.split(':');
    const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
    return legs.some(p => p.base === base && p.exchange === venue && p.side === side)
      && fundingSources.some(b => b.base === base && b.venue === venue && b.side === opposite && b.maturity! > now)
      && !fundingSources.some(b => b.base === base && b.venue === venue && b.side === side && b.maturity! > now);
  });
  const ratioComplete = matchComplete && ratios.every(d => finite(d.value));
  const quantityComplete = ratioComplete && pricesComplete && finite(maxMaterialRatio) && metricNumber30(maxGapUsd) !== null
    && [...exactGaps.values()].every(gap => gap !== null);
  put('hedge.funding_gap_ratio', ratioComplete ? maxRatio : null, seenAt, ratioComplete, 'Incomplete funding quantities / sources', ratios);
  put('hedge.funding_gap_usd', quantityComplete ? metricNumber30(maxGapUsd) : null, seenAt, quantityComplete, 'Missing fresh funding gap USD marks / quantities', dollars);
  put('hedge.funding_material_gap_ratio', quantityComplete ? maxMaterialRatio : null, seenAt, quantityComplete,
    'Missing fresh funding gap USD marks / quantities', ratios);
  put('hedge.funding_unmatched', matchComplete ? unmatched : null, seenAt, matchComplete, 'Incomplete current funding coverage', gaps);
  put('hedge.quantity_verified', quantityComplete ? fundingQuantityVerified(maxMaterialRatio, unmatched, !mismatchedDirection) : null,
    seenAt, quantityComplete, 'Missing fresh funding gap USD marks / quantities', gaps);
  put('hedge.direction_match', matchComplete ? !mismatchedDirection : null, seenAt, matchComplete, 'Incomplete funding direction / quantities');
  // Funding coverage is an account observation, independent of the old two-leg
  // Binance baseline. Sum positive perpetual shortfalls across all ETH venues
  // and maturities, while keeping BTC quantities in their own units.
  const ethGaps = [...exactGaps.entries()].filter(([key]) => key.startsWith('ETH:')).map(([, gap]) => gap);
  const uncovered = matchComplete && ethGaps.every((gap): gap is bigint => gap !== null)
    ? metricNumber18(ethGaps.reduce((sum, gap) => sum + (gap > 0n ? gap : 0n), 0n)) : null;
  const supplement = read(input.supplement)?.data;
  const ethPerps = legs.filter(p => p.base === 'ETH');
  const ethBoros = fundingSources.filter(b => b.base === 'ETH');
  const ethFloating = floating.granted.filter(g => ethPerps.some(p => p.symbol.toUpperCase() === g.symbol));
  const trustedStart = supplement && scopeKey(supplement.scope) === scopeKey(scope)
    && supplement.fundingGapFingerprint === fundingGapFingerprint(ethPerps, ethBoros, scope, ethFloating)
    && supplement.fundingGapEth === uncovered && finite(supplement.fundingGapObservedAt)
    && supplement.fundingGapObservedAt <= now && now - supplement.fundingGapObservedAt <= 3600
    && finite(supplement.fundingGapStartedAt) && supplement.fundingGapStartedAt > 0
    && supplement.fundingGapStartedAt <= supplement.fundingGapObservedAt ? supplement.fundingGapStartedAt : null;
  put('rollover.uncovered_funding_eth', uncovered, seenAt, uncovered !== null, 'Incomplete account funding coverage', gaps);
  put('rollover.uncovered_funding_seconds', uncovered === 0 ? 0 : uncovered !== null && trustedStart !== null ? now - trustedStart : null,
    seenAt, uncovered === 0 || uncovered !== null && trustedStart !== null,
    'Missing verified continuous collector history; page visits never start the clock');
  for (const [venue, id] of [['HYPERLIQUID', 'hl'], ['BINANCE', 'binance']] as const) put(`hedge.${id}_size_gap_eth`,
    matchComplete ? metricNumber18([...exactGaps.entries()].filter(([key]) => key.startsWith(`ETH:${venue}:`))
      .reduce((max, [, gap]) => gap === null ? max : abs18(gap) > max ? abs18(gap) : max, 0n)) : null,
    seenAt, matchComplete, 'Incomplete funding quantities', gaps);
  const expired = boros.filter(b => b.maturity! <= now);
  const expiredGroups = new Map<string, bigint>();
  let expiredUsd = 0n;
  let valuationComplete = true;
  let ordinary = true;
  for (const leg of expired) {
    const size = exact18(leg.sizeBase);
    const usd = exact18(leg.notionalUsdExact);
    if (usd === null || usd < 0n) valuationComplete = false;
    else expiredUsd += usd;
    if (size === null || leg.spreadVenues?.length) { ordinary = false; continue; }
    const key = `${leg.base}:${leg.maturity}`;
    expiredGroups.set(key, (expiredGroups.get(key) ?? 0n) + (leg.side === 'LONG' ? size : -size));
  }
  const balanced = ordinary && [...expiredGroups.values()].every(size => size === 0n);
  const maturityMatch = !borosComplete ? null : !balanced || expiredUsd > BigInt(MIN_ORDER_VALUE_USD) * SCALE18
    ? false : !valuationComplete ? null : true;
  const expiredDetails = expired.map(leg => {
    const date = new Date(leg.maturity! * 1000);
    const maturity = Number.isFinite(date.getTime()) ? date.toISOString() : String(leg.maturity);
    return { label: `${leg.base} ${leg.venue} #${leg.marketId} ${leg.side}`, value: leg.sizeBase ?? null,
      unit: leg.base ?? '', reason: `到期 ${maturity}；名义价值 ${leg.notionalUsdExact ?? 'UNKNOWN'} USD` };
  });
  put('hedge.maturity_match', maturityMatch, asset?.time ?? null, borosComplete && maturityMatch !== null,
    'Incomplete funding maturities or expired position USD valuations', expiredDetails);
  // Dust (at or below the venue's minimum order value) can only settle, so it
  // must not set the rollover clock: a $2 remainder would otherwise keep a fully
  // rolled position "9 days from maturity" and page the operator forever.
  const clockLegs = boros.filter(materialBorosLeg);
  const days = borosComplete && clockLegs.length ? (Math.min(...clockLegs.map(b => b.maturity!)) - now) / 86400 : null;
  put('rollover.days_to_maturity', days, asset?.time ?? null, borosComplete, 'Missing complete live maturities; empty account has no maturity clock');
  if (borosComplete && boros.length && !clockLegs.length) {
    metrics['rollover.days_to_maturity'].applicability = 'NA';
    metrics['rollover.days_to_maturity'].reason = `Only sub-minimum legs remain (each at or below $${MIN_ORDER_VALUE_USD}); nothing is executable, so there is no rollover clock`;
  }
  const complete = Boolean(account && perpsComplete && borosComplete && poolComplete && settlementComplete
    && settlementUsdComplete && borosPnl !== null && borosEquity !== null && gatePnl !== null && residual !== null);
  put('data.coverage_complete', complete, seenAt, true, 'Incomplete ETH/BTC account / collateral pool evidence');
  return { metrics, boros, days, pauseRollover: borosComplete && days !== null && days >= 14, fundingApplicability: floating.known ? floating.granted : null };
}
