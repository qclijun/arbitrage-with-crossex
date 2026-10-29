/**
 * The final two-leg quantity and maker price a funding preview binds
 * (ticket 12), from live venue rules. Quantities are floored to a step both
 * legs can trade and never rounded up; the reason is shown. Rule values must
 * be plain decimals — anything else is unusable, never coerced through a
 * float.
 */
import type { Symbol as RuleSymbol } from 'gate-api';
import type { Side } from '../../core/funding/scenario';
import { formatRestPrice } from '../../core/numbers';
import { fx, fxFloorToStep, fxStr } from '../../engine/fx';
import type { LegSpec } from '../../engine/types';
import type { FundingEvidence } from './evidence';
import type { Blocker } from './gates';
import type { PreviewRequest } from './request';

export const SIDE: Record<Side, 'BUY' | 'SELL'> = { short: 'SELL', long: 'BUY' };

/** A rule value as a canonical decimal string; null when absent or not a
 * plain non-negative decimal of at most 12 places. */
export function ruleDecimal(v: unknown): string | null {
  const text = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
  if (typeof text !== 'string' || !/^\d+(\.\d{1,12})?$/.test(text)) return null;
  return fxStr(fx(text));
}

export interface Sizing { qty: string | null; rounding: string | null; specs: Record<Side, LegSpec> | null }

function legSpec(side: Side, symbol: string, r: RuleSymbol | null, out: Blocker[]): LegSpec | null {
  if (!r) {
    out.push({ code: 'rules-unknown', message: `${symbol} rules could not be read` });
    return null;
  }
  if (r.state !== 'live' || r.businessType !== 'FUTURE') {
    out.push({ code: 'rules-not-tradable', message: `${symbol} is ${r.state} ${r.businessType}` });
    return null;
  }
  const [lot, minSize, minNotional, tick] = [r.lotSize, r.minSize, r.minNotional, r.tickSize].map(ruleDecimal);
  if (!lot || fx(lot) <= 0n || minSize === null || minNotional === null || !tick) {
    out.push({ code: 'rules-invalid', message: `${symbol} has unusable size rules` });
    return null;
  }
  return { contract: symbol, side: SIDE[side], lot, minSize, minNotional, tick };
}

export function size(req: PreviewRequest, rules: Record<Side, RuleSymbol | null>, out: Blocker[]): Sizing {
  const short = legSpec('short', req.short.symbol, rules.short, out);
  const long = legSpec('long', req.long.symbol, rules.long, out);
  if (!short || !long) return { qty: null, rounding: null, specs: null };
  const specs = { short, long };
  const [coarse, fine] = fx(short.lot) >= fx(long.lot) ? [fx(short.lot), fx(long.lot)] : [fx(long.lot), fx(short.lot)];
  if (coarse % fine !== 0n) {
    out.push({ code: 'lot-incompatible', message: `lots ${short.lot} and ${long.lot} share no common step` });
    return { qty: null, rounding: null, specs };
  }
  const input = fx(req.quantity);
  const qty = fxFloorToStep(input, coarse);
  const rounding = qty === input ? null
    : `floored from ${req.quantity} to ${fxStr(qty)}: both legs trade in steps of ${fxStr(coarse)}`;
  if (qty <= 0n) {
    out.push({ code: 'quantity-below-lot', message: `${req.quantity} is below one step of ${fxStr(coarse)}` });
    return { qty: null, rounding, specs };
  }
  for (const side of ['short', 'long'] as const) {
    const r = rules[side]!;
    if (qty < fx(specs[side].minSize)) {
      out.push({ code: 'quantity-below-minimum', message: `${fxStr(qty)} is below ${r.symbol}'s minimum ${specs[side].minSize}` });
    }
    // The maker leg rests as a limit order and converts at expiry as market.
    const caps = [r.maxMarketSize, ...(side === req.makerLeg ? [r.maxLimitSize] : [])].map(ruleDecimal);
    if (caps.some((c) => c !== null && fx(c) > 0n && qty > fx(c))) {
      out.push({ code: 'quantity-above-maximum', message: `${fxStr(qty)} exceeds ${r.symbol}'s maximum order size` });
    }
  }
  return { qty: fxStr(qty), rounding, specs };
}

/** The confirmed price, or the maker leg's own-side best read this round —
 * snapped away from crossing. */
export function makerPrice(req: PreviewRequest, ev: FundingEvidence, spec: LegSpec | undefined): string | null {
  const book = ev.costs[req.makerLeg].book;
  const best = book.status !== 'known' ? null : (SIDE[req.makerLeg] === 'BUY' ? book.bids[0]?.[0] : book.asks[0]?.[0]) ?? null;
  const raw = req.makerPrice ?? best;
  if (raw === null || !spec) return null;
  return formatRestPrice(Number(raw), SIDE[req.makerLeg], spec.contract, spec.tick);
}
