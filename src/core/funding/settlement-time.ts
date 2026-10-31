/** Venue funding timestamps can contain the processing milliseconds after UTC settlement. */
const HOUR = 3_600_000;
const DOCS: Record<string, string> = {
  HYPERLIQUID: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding',
  ASTER: 'https://github.com/asterdex/api-docs/blob/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md#get-funding-rate-history',
};

/**
 * Public calibration on 2026-10-31 corroborates sub-second delays at scheduled
 * hours (HL +13..111ms, Aster +2ms). This bounded mapping is not cadence/listing
 * evidence: those independent checks still apply. Never round arbitrary times.
 */
export function settlementTimeMapping(venue: string, value: unknown): { settlementAt: number; evidence: string } | undefined {
  if (!DOCS[venue] || (typeof value !== 'string' && typeof value !== 'number')
    || !/^\d+$/.test(String(value))) return undefined;
  const rawTime = Number(value);
  if (!Number.isSafeInteger(rawTime) || rawTime < 0 || rawTime % HOUR >= 1_000) return undefined;
  return { settlementAt: rawTime - rawTime % HOUR,
    evidence: `${DOCS[venue]}#utc-hour-subsecond-processing-delay;calibration=2026-10-31` };
}
