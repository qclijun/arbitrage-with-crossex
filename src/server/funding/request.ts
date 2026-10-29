/**
 * What a funding-opportunity preview asks for, and what the user confirms
 * (ticket 12). The request names the exact candidate — both legs' venue
 * contract and CrossEx symbol, the history snapshot and window — and the
 * user's own numbers. Nothing is defaulted that the user must choose: maker
 * leg and both leverages are required; only the maker timeout has the
 * documented 300 s default, and an out-of-range one is refused, never clamped.
 */
import { createHash } from 'node:crypto';
import { CoreError } from '../../core/errors';
import { exact, sign } from '../../core/funding/exact';
import { HISTORY_DAYS, type HistoryDays } from '../../core/funding/history';
import type { Side } from '../../core/funding/scenario';
import { parseSymbol } from '../../core/numbers';
import { TIMEOUT_DEFAULT_S, TIMEOUT_MAX_S, TIMEOUT_MIN_S } from './timeouts';

export interface RequestLeg { venue: string; contractId: string; symbol: string }

export interface PreviewRequest {
  underlying: string;
  short: RequestLeg;
  long: RequestLeg;
  snapshotId: string;
  windowDays: HistoryDays;
  /** Underlying quantity as typed; the preview shows what it rounds to. */
  quantity: string;
  makerLeg: Side;
  leverage: Record<Side, string>;
  /** null: rest at the maker leg's own-side best, read now and then bound. */
  makerPrice: string | null;
  timeoutSec: number;
  holdDays: string;
}

export { TIMEOUT_DEFAULT_S, TIMEOUT_MAX_S, TIMEOUT_MIN_S };
/** Amounts are shown in the legs' shared quote; a USDT/USDC mix in USDT. */
export function currencyOf(r: Pick<PreviewRequest, 'short' | 'long'>): string {
  const [a, b] = [parseSymbol(r.short.symbol).quote, parseSymbol(r.long.symbol).quote];
  return a === b ? a : 'USDT';
}

const bad = (message: string): never => {
  throw new CoreError(message, 'validation');
};

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > 80) bad(`${what} is required`);
  return (v as string).trim();
};

const positive = (v: unknown, what: string): string => {
  const value = typeof v === 'string' && /^\d+(\.\d{1,12})?$/.test(v) ? exact(v) : null;
  if (!value || sign(value) <= 0) bad(`${what} must be a positive decimal string of at most 12 decimals`);
  return v as string;
};

function leg(raw: unknown, side: Side): RequestLeg {
  const l = (raw ?? {}) as Record<string, unknown>;
  return { venue: text(l.venue, `${side} venue`).toUpperCase(), contractId: text(l.contractId, `${side} contract`),
    symbol: text(l.symbol, `${side} symbol`).toUpperCase() };
}

export function parsePreviewRequest(body: unknown): PreviewRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const lev = (b.leverage ?? {}) as Record<string, unknown>;
  if (b.makerLeg !== 'short' && b.makerLeg !== 'long') bad("makerLeg must be 'short' or 'long'");
  if (!HISTORY_DAYS.includes(b.windowDays as HistoryDays)) bad(`windowDays must be one of ${HISTORY_DAYS.join(', ')}`);
  const timeoutSec = b.timeoutSec === undefined ? TIMEOUT_DEFAULT_S : b.timeoutSec;
  if (!Number.isInteger(timeoutSec) || (timeoutSec as number) < TIMEOUT_MIN_S || (timeoutSec as number) > TIMEOUT_MAX_S) {
    bad(`timeoutSec must be a whole number of seconds from ${TIMEOUT_MIN_S} to ${TIMEOUT_MAX_S}`);
  }
  for (const side of ['short', 'long'] as const) {
    if (typeof lev[side] !== 'string' || !/^[1-9]\d{0,2}$/.test(lev[side] as string)) bad(`${side} leverage must be a whole number from 1`);
  }
  return {
    underlying: text(b.underlying, 'underlying').toUpperCase(),
    short: leg(b.short, 'short'),
    long: leg(b.long, 'long'),
    snapshotId: text(b.snapshotId, 'snapshotId'),
    windowDays: b.windowDays as HistoryDays,
    quantity: positive(b.quantity, 'quantity'),
    makerLeg: b.makerLeg as Side,
    leverage: { short: lev.short as string, long: lev.long as string },
    makerPrice: b.makerPrice === undefined || b.makerPrice === null ? null : positive(b.makerPrice, 'makerPrice'),
    timeoutSec: timeoutSec as number,
    holdDays: positive(b.holdDays, 'holdDays'),
  };
}

/** The stable candidate identity ranking uses (core/funding/ranking.ts). */
export const candidateIdOf = (r: PreviewRequest): string =>
  JSON.stringify([r.underlying, r.short.venue, r.short.contractId, r.long.venue, r.long.contractId]);

/** What the user confirms, at the precision they see it: common-currency
 * amounts to 2 decimals, payback to 1; parameters, fee rates, borrow/FX and
 * warnings exactly. Any difference is a new preview. */
export interface PreviewContent {
  candidateId: string;
  underlying: string;
  snapshotId: string;
  cutoff: number | null;
  windowDays: HistoryDays;
  legs: Record<Side, RequestLeg & { side: 'BUY' | 'SELL'; role: 'maker' | 'hedge'; leverage: string }>;
  quantityInput: string;
  quantity: string | null;
  rounding: string | null;
  makerPrice: string | null;
  timeoutSec: number;
  /** The only expiry behavior: the unfilled maker remainder converts to taker. */
  onExpiry: 'convert-to-taker';
  holdDays: string;
  currency: string;
  fees: Record<Side, { maker: string; taker: string } | null>;
  fx: string;
  borrow: string;
  amounts: Record<'normalOneTime' | 'conversionOneTime' | 'daily' | 'normalHold' | 'conversionHold', string | null>;
  payback: { normal: string; conversion: string };
  warnings: string[];
}

export const contentHash = (content: PreviewContent): string =>
  createHash('sha256').update(JSON.stringify(content)).digest('hex');
