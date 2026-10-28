/**
 * Which perpetual quantity is PROVEN intentionally floating (ticket 16;
 * risk-applicability.md), and so needs no Boros funding coverage.
 *
 * Only a funding-two-leg slice proves it, and only for what both of its legs
 * actually hold — min(long, short); a one-legged remainder is not a two-leg
 * strategy. Both contracts must be reconciled, on a reading equal to the
 * position this report reads, from evidence at most 12 s old; the floating
 * quantity must fit inside that position. Anything else exempts nothing: the
 * old coverage checks apply unchanged. The exemption drops the Boros
 * requirement, never claims coverage — the floating exposure is listed, and
 * price/margin/execution risk is untouched.
 *
 * `known` is false when a floating slice exists but could not be proven now
 * (evidence unread, a contract unreconciled or read differently): the
 * exemption is then UNKNOWN rather than absent, so no continuous-gap history
 * is restarted or extended on it.
 */
import { formatDecimal18, parseDecimal18 } from '../../../src/core/boros/decimal18';
import type { Reconciliation } from '../../../src/engine/slice-reconcile';
import type { SliceView } from '../../../src/engine/slice-queries';

/** GET /api/slices (src/server/routes/slices.ts). */
export interface SlicesResponse {
  slices: Array<SliceView & { reducible: Record<string, { qty: string; reserved: string; reducible: string }> }>;
  contracts: Array<{ contract: string } & Reconciliation>;
}

/** One proven floating quantity, as carried in the report and the
 * continuous-gap identity (src/core/risk.ts fundingGapFingerprint). */
export interface FloatingExemption { symbol: string; side: 'LONG' | 'SHORT'; qty: string; sliceIds: string[] }

export const SLICE_EVIDENCE_MAX_AGE_SECONDS = 12;

/** A held perpetual leg as the account producer reads it. */
interface HeldLeg { symbol: string; base: string; exchange: string; side: string; qty18: bigint | null; signedQty18: bigint | null }

export interface Applicability {
  /** Proven floating quantity (18-dp) per `base:venue:side` funding source. */
  byKey: Map<string, bigint>;
  /** Why each source got (or was refused) an exemption. */
  notes: Map<string, string>;
  /** What was granted, for the report and the gap identity. */
  granted: FloatingExemption[];
  /** False when floating quantity exists that cannot be proven now. */
  known: boolean;
}

const sourceKey = (leg: HeldLeg, side: string) => `${leg.base}:${leg.exchange}:${side}`;
const heldLeg = (legs: HeldLeg[], symbol: string, side: string) => legs.find((l) => l.symbol.toUpperCase() === symbol && l.side === side);

export function floatingApplicability(snapshot: SlicesResponse | null, legs: HeldLeg[]): Applicability {
  const result: Applicability = { byKey: new Map(), notes: new Map(), granted: [], known: true };
  if (!snapshot) return { ...result, known: false };
  const reconciledOn = new Map(snapshot.contracts.filter((c) => c.status === 'reconciled' && !c.unknown && c.actual !== null)
    .map((c) => [c.contract.toUpperCase(), c.actual!]));
  // Reconciled on the reading THIS report holds, not merely on /slices' own.
  const provenNow = (contract: string): boolean => {
    const actual = reconciledOn.get(contract.toUpperCase());
    const signed = legs.find((l) => l.symbol.toUpperCase() === contract.toUpperCase())?.signedQty18 ?? 0n;
    return actual !== undefined && parseDecimal18(actual) === signed;
  };
  const totals = new Map<string, { symbol: string; side: 'LONG' | 'SHORT'; qty: bigint; sliceIds: string[] }>();
  for (const slice of snapshot.slices) {
    if (slice.kind !== 'funding-two-leg' || slice.legs.length !== 2) continue;
    const long = slice.legs.find((l) => l.side === 'long');
    const short = slice.legs.find((l) => l.side === 'short');
    const longQty = long ? parseDecimal18(long.qty) : null;
    const shortQty = short ? parseDecimal18(short.qty) : null;
    if (!long || !short || longQty === null || shortQty === null) continue;
    const both = longQty < shortQty ? longQty : shortQty;
    if (both <= 0n) continue;
    if (!provenNow(long.contract) || !provenNow(short.contract)) {
      result.known = false;
      continue;
    }
    for (const [leg, side] of [[long, 'LONG'], [short, 'SHORT']] as const) {
      const symbol = leg.contract.toUpperCase();
      const id = `${symbol}|${side}`;
      const t = totals.get(id) ?? { symbol, side, qty: 0n, sliceIds: [] };
      totals.set(id, { ...t, qty: t.qty + both, sliceIds: [...t.sliceIds, slice.id] });
    }
  }
  const refused = new Set<string>();
  const candidates: Array<{ key: string; total: { symbol: string; side: 'LONG' | 'SHORT'; qty: bigint; sliceIds: string[] }; base: string }> = [];
  for (const total of totals.values()) {
    const held = heldLeg(legs, total.symbol, total.side);
    if (!held || held.qty18 === null || total.qty > held.qty18) {
      result.known = false;
      if (held) {
        refused.add(sourceKey(held, total.side));
        result.notes.set(sourceKey(held, total.side), `slice evidence for ${total.symbol} (${formatDecimal18(total.qty)}) exceeds the held position; no exemption`);
      }
      continue;
    }
    candidates.push({ key: sourceKey(held, total.side), total, base: held.base });
  }
  // A source refused for one contract keeps no exemption granted for another.
  for (const { key, total, base } of candidates) {
    if (refused.has(key)) continue;
    result.byKey.set(key, (result.byKey.get(key) ?? 0n) + total.qty);
    result.notes.set(key, `intentionally floating ${formatDecimal18(total.qty)} ${base} (slice ${total.sliceIds.join(', ')})`);
    result.granted.push({ symbol: total.symbol, side: total.side, qty: formatDecimal18(total.qty), sliceIds: total.sliceIds });
  }
  return result;
}
