import { MIN_ORDER_VALUE_USD } from './risk';
import { parseDecimal18 } from '../../../src/core/boros/decimal18';

const SCALE18 = 1_000_000_000_000_000_000n;

interface BorosLeg {
  maturity?: number | null;
  sizeBase?: string | null;
  notionalUsdExact?: string | null;
  spreadVenues?: readonly unknown[] | null;
  base?: string | null;
  side?: string | null;
  venue?: string | null;
  marketId?: number | null;
}

/**
 * Classifies Boros legs already past maturity for `hedge.maturity_match`: true
 * only when every expired group nets to zero by base and maturity and their
 * total USD value stays within the minimum order value; null when complete
 * positions lack a valid USD valuation.
 */
export function expiredBorosResiduals(boros: readonly BorosLeg[], now: number, borosComplete: boolean) {
  const expired = boros.filter(b => b.maturity! <= now);
  const expiredGroups = new Map<string, bigint>();
  let expiredUsd = 0n;
  let valuationComplete = true;
  let ordinary = true;
  for (const leg of expired) {
    const size = parseDecimal18(leg.sizeBase);
    const usd = parseDecimal18(leg.notionalUsdExact);
    if (usd === null || usd < 0n) valuationComplete = false;
    else expiredUsd += usd;
    if (size === null || leg.spreadVenues?.length) { ordinary = false; continue; }
    const key = `${leg.base}:${leg.maturity}`;
    expiredGroups.set(key, (expiredGroups.get(key) ?? 0n) + (leg.side === 'LONG' ? size : -size));
  }
  const balanced = ordinary && [...expiredGroups.values()].every(size => size === 0n);
  const maturityMatch = !borosComplete ? null : !balanced || expiredUsd > BigInt(MIN_ORDER_VALUE_USD) * SCALE18
    ? false : !valuationComplete ? null : true;
  const details = expired.map(leg => {
    const date = new Date(leg.maturity! * 1000);
    const maturity = Number.isFinite(date.getTime()) ? date.toISOString() : String(leg.maturity);
    return { label: `${leg.base} ${leg.venue} #${leg.marketId} ${leg.side}`, value: leg.sizeBase ?? null,
      unit: leg.base ?? '', reason: `到期 ${maturity}；名义价值 ${leg.notionalUsdExact ?? 'UNKNOWN'} USD` };
  });
  return { maturityMatch, details };
}
