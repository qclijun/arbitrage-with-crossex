/** Per-market diagnostic metrics from #03's public snapshot; no execution
 * quantity, margin, slippage setting or aggregate across markets. */
import { formatYuRaw, record, type bookInputs, type Evidence } from './liquidity';

type Book = ReturnType<typeof bookInputs>;
type Side = Book['bids'];
type Provenance = Pick<Evidence<unknown>, 'source' | 'marketKey' | 'sourceObservedAt' | 'sourceSyncStatus'
  | 'collectedAt' | 'freshness' | 'completeness' | 'reason'>;
export interface Metric<T> extends Evidence<T> { inputs: Provenance[] }
interface CollateralIdentity { tokenId: number | null; assetId: string | null; symbol: string | null }

/** Derived measurements preserve all input clocks without copying book arrays
 * into every metric. Completeness describes the metric's stated scope. */
function metric<T>(value: T | null, unit: string, formula: string, inputs: Evidence<unknown>[],
  completeness: Evidence<T>['completeness'], reason: string[] = []): Metric<T> {
  const provenance = inputs.map(({ source, marketKey, sourceObservedAt, sourceSyncStatus, collectedAt, freshness, completeness, reason }) =>
    ({ source, marketKey, sourceObservedAt, sourceSyncStatus, collectedAt, freshness, completeness, reason }));
  const first = inputs[0];
  return { value, raw: null, unit, source: `derived:${formula}`, marketKey: first.marketKey,
    sourceObservedAt: inputs.every(i => i.sourceObservedAt === first.sourceObservedAt) ? first.sourceObservedAt : null,
    sourceSyncStatus: inputs.every(i => i.sourceSyncStatus === first.sourceSyncStatus) ? first.sourceSyncStatus : null,
    collectedAt: inputs.some(i => i.collectedAt === null) ? null : Math.min(...inputs.map(i => i.collectedAt!)),
    freshness: inputs.some(i => i.freshness === 'stale') ? 'stale' : inputs.some(i => i.freshness === 'unknown') ? 'unknown' : 'fresh',
    completeness: value === null ? 'unknown' : completeness,
    reason: [...new Set([...inputs.flatMap(i => i.reason), ...reason])], inputs: provenance };
}

function bestIndex(side: Side): number | null {
  return side.value?.[0]?.aggregateIndex ?? null;
}
function validBest(side: Side): boolean {
  return side.value !== null && side.discardedLevels === 0 && !side.reason.includes('UPSTREAM_CAP_CONTRACT_VIOLATION');
}
function depth(side: Side, collateral: Evidence<CollateralIdentity>, levels: Side['value'], completeness: Evidence<string>['completeness'], reason: string[] = []) {
  // An all-invalid response is not a confirmed empty book.
  const known = levels !== null && (levels.length > 0 || side.returnedLevels === 0);
  const value = known ? formatYuRaw(levels.reduce((sum, level) => sum + BigInt(level.sizeRaw), 0n).toString()) : null;
  const nativeKnown = collateral.value?.tokenId !== null && collateral.value?.assetId && collateral.value?.symbol
    && collateral.marketKey === side.marketKey;
  const quantityReason = [...reason, ...(known ? [] : ['DEPTH_UNAVAILABLE'])];
  const price = record(collateral.raw).usdPrice;
  return {
    yu: metric(value, 'YU', 'sum(sizeRaw)/1e18', [side], completeness, quantityReason),
    collateralNotional: metric(nativeKnown ? value : null, nativeKnown ? `${collateral.value!.symbol}-notional` : 'collateral-notional',
      'YU=collateral-denominated-notional', [side, collateral], completeness,
      [...quantityReason, ...(nativeKnown ? ['NOMINAL_EXPOSURE_NOT_CASH_OR_MARGIN'] : ['COLLATERAL_IDENTITY_UNKNOWN'])]),
    // #03's official assets response has no price-update clock. Receipt time,
    // underlying assetMarkPrice and stablecoin=1 are not trusted USD quotes.
    usdNotional: metric<number>(null, 'USD-notional', 'YU*collateral.usdPrice', [side, collateral], 'unknown',
      ['PRICE_SOURCE_TIME_UNKNOWN', ...(typeof price === 'number' && Number.isFinite(price) && price > 0 ? [] : ['PRICE_MISSING_OR_INVALID'])]),
  };
}

export function calculateLiquidityMetrics(book: Book, collateral: Evidence<CollateralIdentity>) {
  const bid = bestIndex(book.bids);
  const ask = bestIndex(book.asks);
  const both = bid !== null && ask !== null;
  const crossed = both ? ask < bid : null;
  const spreadTicks = both ? ask - bid : null;
  const pairedCompleteness = validBest(book.bids) && validBest(book.asks) ? 'complete' : 'partial';
  const pairedReasons = [...(both ? [] : ['BEST_APR_UNAVAILABLE']), ...(crossed ? ['CROSSED_BOOK'] : [])];
  const paired = <T>(value: T | null, unit: string, formula: string) => metric(value, unit, formula,
    [book.bids, book.asks], crossed ? 'partial' : pairedCompleteness, pairedReasons);
  const sideMetrics = (side: Side, direction: 'bids' | 'asks') => {
    const best = bestIndex(side);
    const scope = side.completeness;
    return {
      levelCount: metric(side.value?.length ?? null, 'levels', 'valid-returned-level-count', [side], scope),
      farthestApr: metric(side.value?.at(-1)?.apr ?? null, 'APR-fraction', 'farthest-returned-aggregateIndex*tickSize', [side], scope,
        best === null ? ['BEST_APR_UNAVAILABLE'] : []),
      visibleDepth: depth(side, collateral, side.value, scope),
      windows: ([10, 25, 50] as const).map(widthAprBp => {
        // The verified tickSize is 1 APR bp. Integer index differences avoid
        // floating-point exclusion of exactly 10/25/50 bp endpoint levels.
        const distance = (index: number) => direction === 'bids'
          ? BigInt(best!) - BigInt(index) : BigInt(index) - BigInt(best!);
        const levels = best === null ? null : side.value!.filter(level => distance(level.aggregateIndex) <= BigInt(widthAprBp));
        const tail = side.value?.at(-1);
        const bounded = best !== null && tail !== undefined && validBest(side) && distance(tail.aggregateIndex) > BigInt(widthAprBp);
        const coverage = best === null ? 'unknown' : !validBest(side) ? 'partial'
          : bounded ? 'bounded-aggregation-window' : side.potentiallyTruncated ? 'lower-bound' : 'coverage-unknown';
        const windowReason = bounded ? [] : [best === null ? 'WINDOW_BEST_UNAVAILABLE'
          : coverage === 'lower-bound' ? 'WINDOW_DEPTH_LOWER_BOUND' : 'WINDOW_COVERAGE_UNKNOWN'];
        return {
          widthAprBp, widthApr: widthAprBp / 10000, endpointsInclusive: true,
          fromApr: best === null ? null : (direction === 'bids' ? best - widthAprBp : best) * book.tickSize,
          toApr: best === null ? null : (direction === 'bids' ? best : best + widthAprBp) * book.tickSize,
          coverage, depth: depth(side, collateral, levels, bounded ? 'complete' : 'partial', windowReason),
        };
      }),
    };
  };
  return {
    bookTickSize: book.tickSize, aprConvention: 'aggregated-fraction', depthCoverage: 'returned-levels', quantityPrecision: 'exact-decimal-string',
    bestBidApr: metric(bid === null ? null : bid * book.tickSize, 'APR-fraction', 'best-long-aggregateIndex*tickSize', [book.bids],
      validBest(book.bids) ? 'complete' : 'partial', bid === null ? ['BEST_APR_UNAVAILABLE'] : []),
    bestAskApr: metric(ask === null ? null : ask * book.tickSize, 'APR-fraction', 'best-short-aggregateIndex*tickSize', [book.asks],
      validBest(book.asks) ? 'complete' : 'partial', ask === null ? ['BEST_APR_UNAVAILABLE'] : []),
    midApr: paired(both ? (bid + ask) * book.tickSize / 2 : null, 'APR-fraction', '(bestBid+bestAsk)/2'),
    spreadApr: paired(spreadTicks === null ? null : spreadTicks * book.tickSize, 'APR-fraction', 'bestAsk-bestBid'),
    spreadPp: paired(spreadTicks === null ? null : spreadTicks * book.tickSize * 100, 'APR-pp', '100*(bestAsk-bestBid)'),
    spreadAprBp: paired(spreadTicks === null ? null : spreadTicks * book.tickSize * 10000, 'APR-bp', '10000*(bestAsk-bestBid)'),
    crossed, bids: sideMetrics(book.bids, 'bids'), asks: sideMetrics(book.asks, 'asks'),
  };
}
