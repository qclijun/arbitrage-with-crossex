/**
 * The opportunity order draft (ticket 13): what the user types, kept as typed.
 * Nothing is defaulted that the user must choose — maker leg, both leverages,
 * quantity and hold days — and a value out of range is an error, never clamped.
 */
import type { BoardRow } from '../../api/fundingOpportunities';
import type { FundingPreviewRequest } from '../../api/fundingIntents';

export interface OrderDraft {
  quantity: string;
  makerLeg: 'short' | 'long' | null;
  leverageShort: string;
  leverageLong: string;
  /** Blank: rest at the maker leg's own-side best, read and bound by the preview. */
  makerPrice: string;
  timeoutSec: string;
  holdDays: string;
}

export const EMPTY_DRAFT: OrderDraft = {
  quantity: '', makerLeg: null, leverageShort: '', leverageLong: '', makerPrice: '', timeoutSec: '300', holdDays: '',
};

const DECIMAL = /^\d+(\.\d{1,12})?$/;
const positive = (v: string) => DECIMAL.test(v) && /[1-9]/.test(v);
const LEVERAGE = /^[1-9]\d{0,2}$/;
export const TIMEOUT_RANGE = { min: 30, max: 3_600 };

/** Why the draft cannot be previewed yet, per field; empty when it can. */
export function draftErrors(d: OrderDraft): Partial<Record<keyof OrderDraft, string>> {
  const out: Partial<Record<keyof OrderDraft, string>> = {};
  if (!positive(d.quantity)) out.quantity = 'a positive decimal, at most 12 decimals';
  if (!d.makerLeg) out.makerLeg = 'choose which leg rests as maker';
  if (!LEVERAGE.test(d.leverageShort)) out.leverageShort = 'a whole number from 1';
  if (!LEVERAGE.test(d.leverageLong)) out.leverageLong = 'a whole number from 1';
  if (d.makerPrice !== '' && !positive(d.makerPrice)) out.makerPrice = 'blank, or a positive decimal';
  const t = /^\d+$/.test(d.timeoutSec) ? Number(d.timeoutSec) : NaN;
  if (!(t >= TIMEOUT_RANGE.min && t <= TIMEOUT_RANGE.max)) out.timeoutSec = `whole seconds from ${TIMEOUT_RANGE.min} to ${TIMEOUT_RANGE.max}`;
  if (!positive(d.holdDays)) out.holdDays = 'a positive number of days (scenario only)';
  return out;
}

/** The exact request for this candidate; call only on a draft without errors. */
export function previewRequest(row: BoardRow, days: number, snapshotId: string, d: OrderDraft): FundingPreviewRequest {
  return {
    underlying: row.underlying,
    short: { venue: row.short.venue, contractId: row.short.contractId, symbol: row.short.symbol! },
    long: { venue: row.long.venue, contractId: row.long.contractId, symbol: row.long.symbol! },
    snapshotId,
    windowDays: days,
    quantity: d.quantity,
    makerLeg: d.makerLeg!,
    leverage: { short: d.leverageShort, long: d.leverageLong },
    makerPrice: d.makerPrice === '' ? null : d.makerPrice,
    timeoutSec: Number(d.timeoutSec),
    holdDays: d.holdDays,
  };
}
