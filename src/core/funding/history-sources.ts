import type { HistoryDays, SettledFundingEvent } from './history';

/** 07 verified these historical records as settled; other feeds need further proof. */
const SETTLED_ENDPOINTS: Record<string, string> = {
  BINANCE: '/fapi/v1/fundingRate',
  ASTER: '/fapi/v3/fundingRate',
  OKX: '/api/v5/public/funding-rate-history',
  BYBIT: '/v5/market/funding/history',
  HYPERLIQUID: 'info:fundingHistory',
};

export function sourceBoundary(venue: string, api: string, days: HistoryDays): 'verified' | 'unknown' | 'unsupported' {
  if (SETTLED_ENDPOINTS[venue] !== api) return 'unknown';
  if (venue === 'OKX' && days >= 180) return 'unsupported';
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

/** Parse only the official final-rate field; the caller proves pages, listing and historical cadence. */
export function normalizeOfficialSettlement(
  source: OfficialHistorySource,
  raw: Record<string, unknown>,
  intervalHours: number,
  evidence: string,
  timeMapping?: { settlementAt: number; evidence: string },
): SettledFundingEvent | null {
  if (sourceBoundary(source.venue, source.api, 7) !== 'verified'
    || !source.contractId || !evidence || !Number.isSafeInteger(intervalHours) || intervalHours <= 0) return null;
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
    default:
      return null;
  }
  const settledAt = safeTimestamp(time);
  if (contract !== source.contractId || settledAt === null || typeof rate !== 'string'
    || !/^-?\d+(?:\.\d+)?$/.test(rate)) return null;
  const hour = Math.floor(settledAt / 3_600_000) * 3_600_000;
  if (settledAt !== hour && (source.venue === 'HYPERLIQUID' || (source.venue === 'BINANCE' && timeMapping))) {
    // Official HL fundingHistory has time = hour + milliseconds, and Binance fundingTime jitters
    // milliseconds past the hour. The caller must prove which UTC settlement hour a raw time denotes;
    // an unmapped Binance time stays raw, off the grid.
    if (!timeMapping?.evidence || timeMapping.settlementAt !== hour) return null;
    return { settledAt: timeMapping.settlementAt, rawTime: settledAt,
      timeMappingEvidence: timeMapping.evidence, rate, intervalHours, status: 'settled', kind, evidence };
  }
  return { settledAt, rate, intervalHours, status: 'settled', kind, evidence };
}
