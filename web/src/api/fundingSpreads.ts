import type { FundingSpreadRow } from '../../../src/core/funding/spreads';
import type { FundingFeedStatus } from '../../../src/server/routes/fundingSpreads';

export type { FundingQuote, FundingSpreadRow } from '../../../src/core/funding/spreads';
export type { FundingFeedStatus } from '../../../src/server/routes/fundingSpreads';

export interface FundingSpreadsResponse {
  rows: FundingSpreadRow[];
  feeds: FundingFeedStatus[];
  /** Set when the account's fee schedule was unreadable and payback assumes this tier. */
  assumedFeeTier: string | null;
}
