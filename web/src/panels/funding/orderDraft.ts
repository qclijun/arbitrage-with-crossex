/**
 * The opportunity order draft (ticket 13): what the user types, kept as typed.
 * A fresh draft is previewable as it stands: the short leg rests as maker and
 * the scenario holds 30 days here; the form fills quantity ($10k per leg, like
 * the Opportunities page) and each leg's max leverage once it has read them.
 * A value out of range is an error, never clamped.
 */
import type { HistoryDays } from '../../../../src/core/funding/history';
import type { Side } from '../../../../src/core/funding/scenario';
import { TIMEOUT_DEFAULT_S, TIMEOUT_MAX_S, TIMEOUT_MIN_S } from '../../../../src/server/funding/timeouts';
import type { FundingPreviewRequest } from '../../api/fundingIntents';
import type { BoardRow } from '../../api/fundingOpportunities';
import { sigFigsDirectional, stripZeros } from '../../lib/ticks';

export interface OrderDraft {
  quantity: string;
  makerLeg: Side;
  leverageShort: string;
  leverageLong: string;
  /** Blank: rest at the maker leg's own-side best, read and bound by the preview. */
  makerPrice: string;
  timeoutSec: string;
  holdDays: string;
}

export const DEFAULT_DRAFT: OrderDraft = {
  quantity: '', makerLeg: 'short', leverageShort: '', leverageLong: '', makerPrice: '', timeoutSec: String(TIMEOUT_DEFAULT_S), holdDays: '30',
};

/** The notional per leg a fresh draft is sized at — the Opportunities page's default. */
export const DEFAULT_NOTIONAL_USD = 10_000;

/** Fields the form fills from live reads, until the user types in them. */
export type SuggestedField = 'quantity' | 'leverageShort' | 'leverageLong';

/**
 * `notionalUsd` worth of the underlying at `price`, floored to four significant
 * figures so the default never sizes above the notional; null when unpriceable.
 */
export function quantityFor(notionalUsd: number, price: number | undefined): string | null {
  if (!price || !Number.isFinite(price) || price <= 0) return null;
  const q = notionalUsd / price;
  const places = Math.min(12, Math.max(0, 4 - Math.ceil(Math.log10(q))));
  const text = stripZeros(sigFigsDirectional(q, 4, 'down').toFixed(places));
  return positive(text) ? text : null;
}

/** A symbol's max leverage as the whole number the leverage field takes; null when unknown. */
export function leverageFor(max: number | undefined): string | null {
  const whole = max === undefined ? NaN : Math.floor(max);
  return LEVERAGE.test(String(whole)) ? String(whole) : null;
}

const DECIMAL = /^\d+(\.\d{1,12})?$/;
const positive = (v: string) => DECIMAL.test(v) && /[1-9]/.test(v);
const LEVERAGE = /^[1-9]\d{0,2}$/;
export const TIMEOUT_RANGE = { min: TIMEOUT_MIN_S, max: TIMEOUT_MAX_S, default: TIMEOUT_DEFAULT_S };

/** Why the draft cannot be previewed yet, per field; empty when it can. */
export function draftErrors(d: OrderDraft): Partial<Record<keyof OrderDraft, string>> {
  const out: Partial<Record<keyof OrderDraft, string>> = {};
  if (!positive(d.quantity)) out.quantity = 'a positive decimal, at most 12 decimals';
  if (!LEVERAGE.test(d.leverageShort)) out.leverageShort = 'a whole number from 1';
  if (!LEVERAGE.test(d.leverageLong)) out.leverageLong = 'a whole number from 1';
  if (d.makerPrice !== '' && !positive(d.makerPrice)) out.makerPrice = 'blank, or a positive decimal';
  const t = /^\d+$/.test(d.timeoutSec) ? Number(d.timeoutSec) : NaN;
  if (!(t >= TIMEOUT_RANGE.min && t <= TIMEOUT_RANGE.max)) out.timeoutSec = `whole seconds from ${TIMEOUT_RANGE.min} to ${TIMEOUT_RANGE.max}`;
  if (!positive(d.holdDays)) out.holdDays = 'a positive number of days (scenario only)';
  return out;
}

/** The exact request for this candidate; call only on a draft without errors. */
export function previewRequest(row: BoardRow, days: HistoryDays, snapshotId: string, d: OrderDraft): FundingPreviewRequest {
  return {
    underlying: row.underlying,
    short: { venue: row.short.venue, contractId: row.short.contractId, symbol: row.short.symbol! },
    long: { venue: row.long.venue, contractId: row.long.contractId, symbol: row.long.symbol! },
    snapshotId,
    windowDays: days,
    quantity: d.quantity,
    makerLeg: d.makerLeg,
    leverage: { short: d.leverageShort, long: d.leverageLong },
    makerPrice: d.makerPrice === '' ? null : d.makerPrice,
    timeoutSec: Number(d.timeoutSec),
    holdDays: d.holdDays,
  };
}
