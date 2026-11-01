/** Venue funding timestamps can contain a processing delay after the UTC settlement hour. */
const HOUR = 3_600_000;

/**
 * Public calibrations corroborate short delays at scheduled hours: HL +13..111 ms
 * and Aster +2 ms (2026-10-31); Gate stamps whole seconds, +0..5 s over 180 days
 * of BTC/ETH (2026-11-01), bounded well inside its shortest 1-hour cadence. This
 * bounded mapping is not cadence/listing evidence: those independent checks
 * still apply. Never round arbitrary times.
 */
const DELAYS: Record<string, { doc: string; maxMs: number; label: string; calibration: string }> = {
  HYPERLIQUID: { doc: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding', maxMs: 1_000,
    label: 'utc-hour-subsecond-processing-delay', calibration: '2026-10-31' },
  ASTER: { doc: 'https://github.com/asterdex/api-docs/blob/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md#get-funding-rate-history',
    maxMs: 1_000, label: 'utc-hour-subsecond-processing-delay', calibration: '2026-10-31' },
  GATE: { doc: 'https://www.gate.com/help/futures/futures-logic/27569/funding-rate-and-funding-fee', maxMs: 60_000,
    label: 'utc-hour-seconds-processing-delay<60s', calibration: '2026-11-01' },
};

/** Whether the venue's settled records may be stamped after the settlement hour. */
export const hasSettlementDelay = (venue: string): boolean => venue in DELAYS;

export function settlementTimeMapping(venue: string, value: unknown): { settlementAt: number; evidence: string } | undefined {
  const delay = DELAYS[venue];
  if (!delay || (typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) return undefined;
  const rawTime = Number(value);
  if (!Number.isSafeInteger(rawTime) || rawTime < 0 || rawTime % HOUR >= delay.maxMs) return undefined;
  return { settlementAt: rawTime - rawTime % HOUR, evidence: `${delay.doc}#${delay.label};calibration=${delay.calibration}` };
}
