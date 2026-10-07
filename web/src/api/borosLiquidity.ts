import type { bookInputs, Evidence, LIQUIDITY_SCOPE, marketInputs } from '../../../src/core/boros/liquidity';
import type { calculateLiquidityMetrics } from '../../../src/core/boros/liquidity-metrics';

export type LiquidityMarket = ReturnType<typeof marketInputs> & {
  collateral: Evidence<{ tokenId: number | null; assetId: string | null; symbol: string | null; decimals: number | null; address: string | null }>;
  book: ReturnType<typeof bookInputs>;
  metrics: ReturnType<typeof calculateLiquidityMetrics>;
};
export interface BorosLiquidityResponse {
  scope: typeof LIQUIDITY_SCOPE;
  coverage: Evidence<{ returnedMarkets: number; pages: number; resumeToken: unknown }>;
  markets: LiquidityMarket[];
}
