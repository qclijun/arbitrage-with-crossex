/**
 * Why a POST /deals opens (ticket 19). The declared purpose picks the gate a
 * request must pass; it grants no Risk exemption or ownership, never falls
 * back to an older protocol, and a 'reduce' label never vouches for a leg that
 * adds risk. Reduce-only legs themselves are proven against live positions in
 * resolveDeal; 'manual' opens face the conflict gate (manualConflicts.ts).
 */
import { parseSymbol } from '../core/numbers';
import type { DealPurpose } from '../engine/types';

/** The Boros side a strategy's perps hedge, as the opening page knew it. */
export interface BorosContext {
  base: string;
  /** Boros venue keys of the rate legs. */
  venues: string[];
  /** Maturity of the rate legs, unix seconds. */
  maturity?: number;
  marketIds?: number[];
  route?: 'spread' | 'singles';
}

interface PurposeBody {
  a?: { symbol?: string; reduceOnly?: boolean } | null;
  b?: { symbol?: string; reduceOnly?: boolean } | null;
  purpose?: unknown;
  boros?: unknown;
}

export type PurposeLabel =
  | 'client-outdated'
  | 'purpose-mismatch'
  | 'purpose-unknown'
  | 'boros-context-invalid'
  | 'funding-admission-required';

export type PurposeDecision =
  | { ok: true; purpose: DealPurpose; context: BorosContext | null }
  | { ok: false; status: 400 | 409; label: PurposeLabel; message: string };

const no = (status: 400 | 409, label: PurposeLabel, message: string): PurposeDecision => ({ ok: false, status, label, message });

function borosContextProblem(raw: unknown, base: string, nowMs: number): string | null {
  if (typeof raw !== 'object' || raw === null) return 'a Boros-strategy open must name the Boros legs it hedges';
  const c = raw as Record<string, unknown>;
  if (typeof c.base !== 'string' || c.base.toUpperCase() !== base) return `the Boros legs are not ${base}`;
  const venues = c.venues;
  if (!Array.isArray(venues) || venues.length < 1 || venues.length > 2 ||
    !venues.every((v) => typeof v === 'string' && v.trim() !== '' && v.length <= 40)) {
    return 'the Boros venues must be one or two venue keys';
  }
  if (c.maturity !== undefined && !(Number.isInteger(c.maturity) && (c.maturity as number) * 1000 > nowMs)) {
    return 'the Boros maturity must be a future unix time in seconds';
  }
  if (c.marketIds !== undefined && !(Array.isArray(c.marketIds) && c.marketIds.every((id) => Number.isInteger(id) && id > 0))) {
    return 'Boros market ids must be positive integers';
  }
  if (c.route !== undefined && c.route !== 'spread' && c.route !== 'singles') return "the Boros route must be 'spread' or 'singles'";
  return null;
}

export function classifyDealPurpose(body: PurposeBody, nowMs: number): PurposeDecision {
  const riskAdding = !body.a?.reduceOnly || (body.b != null && !body.b.reduceOnly);
  const { purpose } = body;
  if (purpose === undefined) {
    if (!riskAdding) return { ok: true, purpose: 'reduce', context: null };
    return no(400, 'client-outdated', 'This page is out of date and cannot open positions. Reload it and try again; closing still works.');
  }
  if (purpose === 'funding-two-leg') {
    return no(409, 'funding-admission-required', 'Funding-opportunity opens are accepted only through the opportunity admission, not as a plain deal.');
  }
  if (purpose !== 'reduce' && purpose !== 'manual' && purpose !== 'boros-strategy') {
    return no(400, 'purpose-unknown', `unknown deal purpose ${JSON.stringify(purpose)}; nothing was created`);
  }
  if ((purpose === 'reduce') === riskAdding) {
    return no(400, 'purpose-mismatch', riskAdding
      ? "a deal labelled 'reduce' must have only reduce-only legs"
      : "a deal whose legs are all reduce-only is purpose 'reduce'");
  }
  if (purpose !== 'boros-strategy') {
    if (body.boros !== undefined) return no(400, 'boros-context-invalid', 'Boros context belongs only to a Boros-strategy open');
    return { ok: true, purpose, context: null };
  }
  const base = parseSymbol(body.a?.symbol ?? '').base.toUpperCase();
  const problem = borosContextProblem(body.boros, base, nowMs);
  if (problem) return no(400, 'boros-context-invalid', `${problem}; nothing was created`);
  return { ok: true, purpose, context: body.boros as BorosContext };
}
