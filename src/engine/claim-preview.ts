import { createHash } from 'node:crypto';
import { parseSymbol } from '../core/numbers';
import { formatDecimal18, parseDecimal18 } from '../core/boros/decimal18';
import { fx, fxStr } from './fx';
import { reconcileContract } from './slice-reconcile';
import type { SliceLedger } from './slices';
import { UNKNOWN_ATTRIBUTION, type ClaimEvidence, type ClaimInput, type ClaimPreview } from './claim-types';

export const CLAIM_MAX_AGE_MS = 10_000;
export class ClaimRefusal extends Error {}
function refuse(message: string): never { throw new ClaimRefusal(message); }

export function previewClaim(slices: SliceLedger, input: ClaimInput, evidence: ClaimEvidence, now: number): ClaimPreview {
  if (evidence.readAt > now || now - evidence.readAt > CLAIM_MAX_AGE_MS) refuse('Current evidence is stale; preview again.');
  if (!['funding-two-leg', 'boros-hedge'].includes(input.kind) || !Array.isArray(input.legs) ||
    input.legs.length !== 2 || !Array.isArray(input.boros)) refuse('Select exactly two perpetual legs and a strategy.');
  const [a, b] = input.legs;
  if (!a || !b || a.contract === b.contract || a.side === b.side ||
    !input.legs.every((l) => typeof l.contract === 'string' && l.contract === l.contract.toUpperCase() &&
      ['long', 'short'].includes(l.side) && typeof l.qty === 'string')) refuse('Select distinct exact contracts with opposite directions.');
  const base = parseSymbol(a.contract).base;
  if (!base || parseSymbol(b.contract).base !== base) refuse('Both legs must have the same underlying base unit.');
  if (input.kind === 'funding-two-leg' && input.boros.length) refuse('Floating two-leg ownership cannot include Boros holdings.');
  const states = input.legs.map((l) => slices.contractState(l.contract));
  const legs = input.legs.map((l, i) => {
    let qty: bigint;
    try { qty = fx(l.qty); } catch { return refuse('Claim quantity must be an exact decimal string.'); }
    if (qty <= 0n || !evidence.contracts.includes(l.contract)) refuse('Positive quantity and a proven live contract are required.');
    if (evidence.openOrders.includes(l.contract)) refuse(`${l.contract} has open venue orders.`);
    const actual = evidence.positions[l.contract];
    if (actual === undefined) refuse(`${l.contract} has no complete current position evidence.`);
    const rec = reconcileContract(states[i], actual);
    if (!['reconciled', 'untracked'].includes(rec.status)) refuse(`${l.contract}: ${rec.status}; explicitly reconcile first.`);
    const available = fx(rec.unattributed!) * (l.side === 'long' ? 1n : -1n);
    if (qty > available) refuse(`${l.contract}: requested quantity exceeds proven unattributed quantity.`);
    return { ...l, qty: fxStr(qty), actual, available: fxStr(available), remaining: fxStr(available - qty) };
  });
  if (fx(a.qty) !== fx(b.qty)) refuse('The two strategy legs must claim the same base quantity.');
  const used = new Map<string, bigint>();
  for (const slice of slices.list().filter((s) => input.kind === 'boros-hedge' && s.kind === 'boros-hedge')) {
    const source = slice.source as { boros?: Array<{ key: string; claimed: string }> } | null;
    if (!source || !Array.isArray(source.boros) || !source.boros.length ||
      !source.boros.every((p) => p && typeof p.key === 'string' && p.key.length > 0 && typeof p.claimed === 'string')) {
      if (input.kind === 'boros-hedge') refuse('Existing Boros ownership has no proven physical allocation; reconcile it first.');
      continue;
    }
    for (const p of source.boros) {
      let quantity: bigint;
      try { quantity = fx(p.claimed); } catch { return refuse('Existing Boros allocation quantity is unproven.'); }
      if (quantity <= 0n) refuse('Existing Boros allocation quantity is unproven.');
      used.set(p.key, (used.get(p.key) ?? 0n) + quantity);
    }
  }
  if (new Set(input.boros.map((p) => p.key)).size !== input.boros.length) refuse('A physical Boros holding may be selected only once.');
  const boros = input.boros.map((p) => {
    const matches = evidence.boros?.filter((h) => h.key === p.key && h.root.toLowerCase() === input.root?.toLowerCase()) ?? [];
    if (matches.length !== 1) refuse('Boros physical identity is missing or duplicated.');
    const holding = matches[0];
    if (!holding || holding.unit !== 'base' || holding.base !== base || !Number.isSafeInteger(holding.maturity) || holding.maturity * 1000 <= now) refuse('Boros identity, base unit, maturity or complete position evidence is missing.');
    let qty: bigint;
    try { qty = fx(p.qty); } catch { return refuse('Boros quantity must be an exact decimal string.'); }
    const held = parseDecimal18(holding.qty);
    if (held === null) refuse('Boros quantity is unproven.');
    const available = held - (used.get(p.key) ?? 0n) * 1_000_000n;
    if (qty <= 0n || qty * 1_000_000n > available) refuse('Boros quantity is already occupied or insufficient.');
    if (!holding.sources.length || holding.sources.some((s) => !legs.some((l) =>
      parseSymbol(l.contract).exchange.toUpperCase() === s.venue.toUpperCase() && l.side === s.side))) refuse('Boros funding direction or source does not match the selected perpetual legs.');
    return { ...holding, claimed: fxStr(qty), remaining: formatDecimal18(available - qty * 1_000_000n) };
  });
  if (input.kind === 'boros-hedge') {
    for (const l of legs) {
      const covered = boros.reduce((sum, h) => sum + (h.sources.some((s) =>
        s.venue.toUpperCase() === parseSymbol(l.contract).exchange.toUpperCase() && s.side === l.side) ? fx(h.claimed) : 0n), 0n);
      if (covered !== fx(l.qty)) refuse('Each perpetual funding source needs exact Boros coverage; excess on another source cannot offset it.');
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ kind: input.kind, legs, states, boros })).digest('hex');
  return { fingerprint, readAt: evidence.readAt, legs, boros, attribution: UNKNOWN_ATTRIBUTION };
}
