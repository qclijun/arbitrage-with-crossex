import type { BorosContext, DealPurposeSpec } from '../api/types';

/** Closes declare it: every leg is reduce-only, proven against the live position. */
export const REDUCE_PURPOSE: DealPurposeSpec = { purpose: 'reduce' };

/**
 * A Boros strategy armed a ticket to open exactly these legs (`legs` is the
 * ticket's own key for them — symbols and sides — taken once the prefill
 * resolved).
 */
export interface BorosArm {
  context: BorosContext;
  legs: string;
}

/** The Boros side a card's perps hedge: one or two rate-leg venues. */
export function borosContext(base: string, venues: string[], maturity?: number): BorosContext {
  return { base, venues: [...new Set(venues)], ...(maturity !== undefined ? { maturity } : {}) };
}

/**
 * What a ticket's open is for. Still on the legs a Boros strategy armed →
 * part of that strategy; any other legs → a stand-alone ('manual') open, which
 * the server admits only where nothing it adds to is already held or working.
 */
export function purposeFor(arm: BorosArm | null, legs: string): DealPurposeSpec {
  return arm && arm.legs === legs ? { purpose: 'boros-strategy', boros: arm.context } : { purpose: 'manual' };
}
