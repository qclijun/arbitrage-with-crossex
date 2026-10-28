/**
 * Which perpetual quantity is PROVEN intentionally floating (ticket 16;
 * risk-applicability.md), and so needs no Boros funding coverage.
 *
 * Only a funding-two-leg slice proves it, and only for what both of its legs
 * actually hold — min(long, short); a one-legged remainder is not a two-leg
 * strategy. Both contracts must be reconciled on the slice ledger's own fresh
 * reading, the evidence must be at most 12 s old, and the floating quantity
 * must fit inside the position this report reads. Anything else exempts
 * nothing: the old coverage checks apply unchanged. The exemption is a
 * reason to drop the Boros requirement, never a claim of coverage — the
 * floating exposure is listed, and price/margin/execution risk is untouched.
 */
import { formatDecimal18, parseDecimal18 } from '../../../src/core/boros/decimal18';

/** GET /api/slices (src/server/routes/slices.ts). */
export interface SlicesResponse {
  slices: Array<{
    id: string; kind: string; source: unknown; createdAt: number;
    legs: Array<{ leg: string; account: string; contract: string; side: 'long' | 'short'; unit: string; qty: string }>;
    reducible: Record<string, { qty: string; reserved: string; reducible: string }>;
  }>;
  contracts: Array<{ contract: string; status: string; unknown: boolean; actual: string | null; explained: string | null; attributed: string; unattributed: string | null }>;
}

/** One proven floating quantity, as carried in the report and the
 * continuous-gap identity. */
export interface FloatingExemption { symbol: string; side: 'LONG' | 'SHORT'; qty: string; sliceIds: string[] }

export const SLICE_EVIDENCE_MAX_AGE_SECONDS = 12;

interface HeldLeg { symbol: string; base: string; exchange: string; side: string; qty18: bigint | null }

export interface Applicability {
  /** Proven floating quantity (18-dp) per `base:venue:side` funding source. */
  byKey: Map<string, bigint>;
  /** Why each source got (or was refused) an exemption. */
  notes: Map<string, string>;
  /** What was granted, for the report and the gap identity. */
  granted: FloatingExemption[];
}

export function floatingApplicability(snapshot: SlicesResponse | null, legs: HeldLeg[]): Applicability {
  const result: Applicability = { byKey: new Map(), notes: new Map(), granted: [] };
  if (!snapshot) return result;
  const reconciled = new Set(snapshot.contracts.filter((c) => c.status === 'reconciled' && !c.unknown).map((c) => c.contract.toUpperCase()));
  const totals = new Map<string, { qty: bigint; sliceIds: string[] }>();
  for (const slice of snapshot.slices) {
    if (slice.kind !== 'funding-two-leg' || slice.legs.length !== 2) continue;
    const long = slice.legs.find((l) => l.side === 'long');
    const short = slice.legs.find((l) => l.side === 'short');
    const longQty = long ? parseDecimal18(long.qty) : null;
    const shortQty = short ? parseDecimal18(short.qty) : null;
    if (!long || !short || longQty === null || shortQty === null) continue;
    if (!reconciled.has(long.contract.toUpperCase()) || !reconciled.has(short.contract.toUpperCase())) continue;
    const both = longQty < shortQty ? longQty : shortQty;
    if (both <= 0n) continue;
    for (const [leg, side] of [[long, 'LONG'], [short, 'SHORT']] as const) {
      const id = `${leg.contract.toUpperCase()}:${side}`;
      const t = totals.get(id) ?? { qty: 0n, sliceIds: [] };
      totals.set(id, { qty: t.qty + both, sliceIds: [...t.sliceIds, slice.id] });
    }
  }
  for (const [id, total] of totals) {
    const [symbol, side] = id.split(':') as [string, 'LONG' | 'SHORT'];
    const held = legs.find((l) => l.symbol.toUpperCase() === symbol && l.side === side);
    const key = held ? `${held.base}:${held.exchange}:${side}` : null;
    if (!held || !key || held.qty18 === null || total.qty > held.qty18) {
      if (key) result.notes.set(key, `slice evidence for ${symbol} (${formatDecimal18(total.qty)}) exceeds the held position; no exemption`);
      continue;
    }
    result.byKey.set(key, (result.byKey.get(key) ?? 0n) + total.qty);
    result.notes.set(key, `intentionally floating ${formatDecimal18(total.qty)} ${held.base} (slice ${total.sliceIds.join(', ')})`);
    result.granted.push({ symbol, side, qty: formatDecimal18(total.qty), sliceIds: total.sliceIds });
  }
  // A key refused for one contract cannot keep an exemption granted for another.
  for (const [key, note] of result.notes) if (note.endsWith('no exemption')) result.byKey.delete(key);
  result.granted = result.granted.filter((g) => {
    const held = legs.find((l) => l.symbol.toUpperCase() === g.symbol && l.side === g.side);
    return held && result.byKey.has(`${held.base}:${held.exchange}:${g.side}`);
  });
  return result;
}
