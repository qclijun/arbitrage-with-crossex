import type { HistoryDays, SettledFundingEvent } from './history';
import { hasSettlementDelay } from './settlement-time';

/** Gate's REST history; it refuses a `from` more than 180 days before its clock. */
export const GATE_HISTORY_API = '/futures/usdt/funding_rate';
export const GATE_HISTORY_DAYS = 180;
/** REST's 180-day limit is retained; this source also reads Gate's official monthly archive. */
export const GATE_ARCHIVE_API = '/futures/usdt/funding_rate+funding_applies';
/** Lighter's hourly perp fundings, read by market id. */
export const LIGHTER_HISTORY_API = '/api/v1/fundings';

/**
 * 07 verified these historical records as settled; other feeds need further proof.
 * Gate and Lighter: .scratch/funding-gate-lighter-history/evidence/.
 */
const SETTLED_ENDPOINTS: Record<string, string> = {
  BINANCE: '/fapi/v1/fundingRate',
  ASTER: '/fapi/v3/fundingRate',
  OKX: '/api/v5/public/funding-rate-history',
  BYBIT: '/v5/market/funding/history',
  HYPERLIQUID: 'info:fundingHistory',
  GATE: GATE_HISTORY_API,
  LIGHTER: LIGHTER_HISTORY_API,
};

/** REST's three-month limit is retained; this source also reads official monthly files. */
export const OKX_ARCHIVE_API = '/api/v5/public/funding-rate-history+market-data-history';

export function sourceBoundary(venue: string, api: string, days: HistoryDays): 'verified' | 'unknown' | 'unsupported' {
  if ((venue === 'OKX' && api === OKX_ARCHIVE_API) || (venue === 'GATE' && api === GATE_ARCHIVE_API)) return 'verified';
  if (SETTLED_ENDPOINTS[venue] !== api) return 'unknown';
  if (venue === 'OKX' && days >= 180) return 'unsupported';
  if (venue === 'GATE' && days > GATE_HISTORY_DAYS) return 'unsupported';
  return 'verified';
}

export interface OfficialHistorySource {
  venue: string;
  api: string;
  /** Venue-native ID, after CrossEx live-contract mapping. */
  contractId: string;
}

function safeTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^[0-9]+$/.test(String(value))) return null;
  const time = Number(value);
  return Number.isSafeInteger(time) ? time : null;
}

/**
 * Lighter writes an unsigned percent per hour; `direction: short` means shorts
 * pay, a negative rate. Returns the signed hourly fraction, the unit of the
 * current rate (its feed's 8-hour equivalent / 8). Verified against the LLP
 * public pool's settled position fundings (evidence/lighter-settled-history.md).
 */
function lighterRate(rate: unknown, direction: unknown): string | null {
  const match = typeof rate === 'string' ? /^(\d+)(?:\.(\d+))?$/.exec(rate) : null;
  if (!match || (direction !== 'long' && direction !== 'short')) return null;
  const places = (match[2] ?? '').length + 2;
  const digits = `${match[1]}${match[2] ?? ''}`.replace(/^0+/, '').padStart(places + 1, '0');
  const fraction = digits.slice(-places).replace(/0+$/, '');
  const value = `${digits.slice(0, -places)}${fraction ? `.${fraction}` : ''}`;
  return direction === 'short' && /[1-9]/.test(value) ? `-${value}` : value;
}

/** Unix seconds as milliseconds; a value already in milliseconds is refused. */
const fromSeconds = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 10_000_000_000 ? (value as number) * 1_000 : null;

/** Parse official final rates independently of the caller's pagination, listing and cadence checks. */
export function normalizeOfficialSettlement(
  source: OfficialHistorySource,
  raw: Record<string, unknown>,
  intervalHours: number | null,
  evidence: string,
  timeMapping?: { settlementAt: number; evidence: string },
): SettledFundingEvent | null {
  if (sourceBoundary(source.venue, source.api, 7) !== 'verified'
    || !source.contractId || !evidence || (intervalHours !== null
      && (!Number.isSafeInteger(intervalHours) || intervalHours <= 0))) return null;
  let contract: unknown;
  let time: unknown;
  let rate: unknown;
  let kind: SettledFundingEvent['kind'] = 'regular';
  switch (source.venue) {
    case 'BINANCE':
    case 'ASTER':
      contract = raw.symbol;
      time = raw.fundingTime;
      rate = raw.fundingRate;
      if (source.venue === 'BINANCE') {
        if (raw.rateType !== undefined && raw.rateType !== 'Regular' && raw.rateType !== 'Special') return null;
        kind = raw.rateType === 'Special' ? 'special' : 'regular';
      }
      break;
    case 'OKX':
      contract = raw.instId;
      time = raw.fundingTime;
      rate = raw.realizedRate;
      break;
    case 'BYBIT':
      contract = raw.symbol;
      time = raw.fundingRateTimestamp;
      rate = raw.fundingRate;
      break;
    case 'HYPERLIQUID':
      contract = raw.coin;
      time = raw.time;
      rate = raw.fundingRate;
      break;
    case 'LIGHTER':
      // Rows name no market; the source tags each with the one it requested.
      contract = raw.market;
      time = fromSeconds(raw.timestamp);
      rate = lighterRate(raw.rate, raw.direction);
      break;
    case 'GATE':
      // Rows name no contract; the source tags each with the one it requested.
      contract = raw.contract;
      time = fromSeconds(raw.t);
      rate = raw.r;
      break;
    default:
      return null;
  }
  const settledAt = safeTimestamp(time);
  if (contract !== source.contractId || settledAt === null || typeof rate !== 'string'
    || !/^-?\d+(?:\.\d+)?$/.test(rate)) return null;
  if (hasSettlementDelay(source.venue) && settledAt % 3_600_000 !== 0) {
    // Preserve the original processing timestamp and the venue mapping's
    // evidence, independently of historical cadence and listing checks.
    if (!timeMapping?.evidence || timeMapping.settlementAt !== Math.floor(settledAt / 3_600_000) * 3_600_000) return null;
    return { settledAt: timeMapping.settlementAt, rawTime: settledAt,
      timeMappingEvidence: timeMapping.evidence, rate, intervalHours, status: 'settled', kind, evidence };
  }
  return { settledAt, rate, intervalHours, status: 'settled', kind, evidence };
}
