/**
 * What the user confirms, at the precision they see it (ticket 12): amounts
 * in the common currency to 2 decimals, payback to 1; parameters, fee rates,
 * the borrow/FX status and warnings exactly. Rates and amounts behind a
 * status ride in the scenario for display, not in what must stay equal.
 */
import { exact, sign } from '../../core/funding/exact';
import { divideRounded } from '../../core/funding/history';
import type { Amount, BorrowEvidence, FeeEvidence, FundingScenario, Payback, Side } from '../../core/funding/scenario';
import { sameLeverage } from '../../engine/leverage';
import type { FundingEvidence } from './evidence';
import { candidateIdOf, type PreviewContent, type PreviewRequest } from './request';
import { SIDE, type Sizing } from './sizing';

/** Risks every confirmation acknowledges, whatever the numbers. */
export const ACKNOWLEDGED = [
  'maker-expiry-converts-remainder-to-taker',
  'taker-ioc-has-no-price-or-cost-cap',
  'one-leg-exposure-until-hedged',
  'trading-permission-inferred-from-signed-reads',
  'risk-exempts-only-reconciled-floating-quantity',
];

function shown(amount: Amount | undefined, places: number): string | null {
  if (!amount || amount.status !== 'known') return null;
  const e = exact(amount.value)!;
  return divideRounded(e.n * 10n ** BigInt(places), e.d, places);
}

const payback = (p: Payback | undefined): string =>
  !p ? 'unknown' : p.kind === 'days' ? shown({ status: 'known', value: p.days }, 1)! : p.kind;

/** The leg's leverage as read this round; null when unread. */
export function currentLeverage(ev: FundingEvidence, symbol: string): string | null {
  const v = ev.leverage?.[symbol];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
}

function warnings(req: PreviewRequest, ev: FundingEvidence, daily: string | null, normalHold: string | null): string[] {
  const out = [...ACKNOWLEDGED];
  for (const side of ['short', 'long'] as const) {
    const now = currentLeverage(ev, req[side].symbol);
    const target = req.leverage[side];
    if (now !== null && !sameLeverage(now, target)) out.push(`leverage-change:${req[side].symbol}:${now}->${target}`);
  }
  if ([daily, normalHold].some((v) => v !== null && sign(exact(v)!) <= 0)) out.push('scenario-not-positive');
  return out;
}

export interface ContentInput {
  req: PreviewRequest;
  ev: FundingEvidence;
  sizing: Sizing;
  price: string | null;
  currency: string;
  borrow: BorrowEvidence;
  scenario: FundingScenario | null;
}

export function contentOf({ req, ev, sizing, price, currency, borrow, scenario }: ContentInput): PreviewContent {
  const leg = (side: Side) => ({ ...req[side], side: SIDE[side], role: side === req.makerLeg ? 'maker' as const : 'hedge' as const,
    leverage: req.leverage[side] });
  const fee = (f: FeeEvidence) => (f.status === 'known' ? { maker: f.maker, taker: f.taker } : null);
  const daily = shown(scenario?.daily, 2);
  const normalHold = shown(scenario?.normal.holdResult, 2);
  return {
    candidateId: candidateIdOf(req), underlying: req.underlying, snapshotId: req.snapshotId,
    cutoff: ev.history.admitted ? ev.history.result.cutoff : null, windowDays: req.windowDays,
    legs: { short: leg('short'), long: leg('long') },
    quantityInput: req.quantity, quantity: sizing.qty, rounding: sizing.rounding, makerPrice: price,
    timeoutSec: req.timeoutSec, onExpiry: 'convert-to-taker', holdDays: req.holdDays, currency,
    fees: { short: fee(ev.costs.short.fees), long: fee(ev.costs.long.fees) },
    fx: ev.fx === null ? 'unknown' : ev.fx.length ? `known:${[...new Set(ev.fx.map((r) => r.from))].sort().join('/')}` : 'none',
    borrow: borrow.status === 'known' ? `known:${borrow.currency}` : borrow.status,
    amounts: {
      normalOneTime: shown(scenario?.normal.oneTime, 2),
      conversionOneTime: shown(scenario?.conversion.oneTime, 2),
      daily,
      normalHold,
      conversionHold: shown(scenario?.conversion.holdResult, 2),
    },
    payback: { normal: payback(scenario?.normal.payback), conversion: payback(scenario?.conversion.payback) },
    warnings: warnings(req, ev, daily, normalHold),
  };
}
