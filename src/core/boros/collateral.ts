import type { BorosCollateralZone, BorosMarginGroup } from './client';
import { rawInteger18ToDecimal } from './decimal18';

export interface CollateralPool {
  marketAcc: string;
  netBalance: number | null;
  netBalanceExact: string | null;
  initialMargin: number | null;
  maintenanceMargin: number | null;
  availableInitialMargin: number | null;
  activePositions: number | null;
  imCoverage: number | null;
  mmCoverage: number | null;
}

function amount(value: unknown): number | null {
  const exact = rawInteger18ToDecimal(value);
  if (exact === null) return null;
  const n = Number(exact);
  return Number.isFinite(n) ? n : null;
}

function pool(group: BorosMarginGroup): CollateralPool {
  const netExact = rawInteger18ToDecimal(group.netBalance);
  const net = amount(group.netBalance);
  const rawIm = amount(group.initialMargin);
  const im = rawIm !== null && rawIm >= 0 ? rawIm : null;
  const available = amount(group.availableInitialMargin);
  const availableMm = amount(group.availableMaintMargin);
  const rawMm = net !== null && availableMm !== null ? net - availableMm : null;
  const mm = rawMm !== null && rawMm >= 0 ? rawMm : null;
  const sizes = group.marketPositions.map((p) => amount(p.notionalSize));
  return {
    marketAcc: group.marketAcc,
    netBalance: net,
    netBalanceExact: netExact,
    initialMargin: im,
    maintenanceMargin: mm,
    availableInitialMargin: available,
    activePositions: group.positionsComplete === true && sizes.every((n) => n !== null)
      ? sizes.filter((n) => n !== 0).length : null,
    imCoverage: net !== null && im !== null && im > 0 ? net / im : null,
    mmCoverage: net !== null && mm !== null && mm > 0 ? net / mm : null,
  };
}

/** Each pool retains its own collateral and margin; never sum safety buffers. */
export function collateralView(zones: BorosCollateralZone[], prices: Map<number, number | null>) {
  return ([['ETH', 2], ['BTC', 1], ['USDT', 3]] as const).map(([symbol, tokenId]) => {
    const zone = zones.find((z) => z.tokenId === tokenId);
    return {
      // The generic resolver assumes USDT=$1; that is not an observed quote.
      symbol, tokenId, priceUsd: tokenId === 3 ? null : prices.get(tokenId) ?? null,
      cross: zone?.cross ? pool(zone.cross) : null,
      isolated: (zone?.isolated ?? []).map(pool),
    };
  });
}
