import type { BorosContext, DealPurposeSpec } from '../api/types';

/**
 * What a ticket's open is for. Armed by a Boros strategy and still on that
 * coin → part of the strategy; otherwise a stand-alone ('manual') open, which
 * the server admits only where nothing it adds to is already held or working.
 */
export function purposeFor(boros: BorosContext | null, base: string | null): DealPurposeSpec {
  if (boros && base && boros.base.toUpperCase() === base.toUpperCase()) return { purpose: 'boros-strategy', boros };
  return { purpose: 'manual' };
}
