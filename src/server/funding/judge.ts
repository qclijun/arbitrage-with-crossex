/**
 * Judge one funding preview request against one evidence round (ticket 12).
 * Pure. Produces what the user would confirm (PreviewContent, at display
 * precision), every reason it cannot be accepted now, and — only when there
 * is none — the exact deal the engine would run. The same function judges the
 * preview and, on fresh evidence, the acceptance; their contents must match.
 */
import type { Symbol as RuleSymbol } from 'gate-api';
import { SUPPORTED_COINS } from '../../core/coins';
import { cmp, exact, mul, sign } from '../../core/funding/exact';
import { divideRounded } from '../../core/funding/history';
import { underlyingOf } from '../../core/funding/spreads';
import { estimateFundingScenario, type Amount, type FundingScenario, type Payback, type Side } from '../../core/funding/scenario';
import { formatRestPrice, parseSymbol } from '../../core/numbers';
import type { AdmissionState } from '../../engine/admission';
import { fx, fxFloorToStep, fxStr } from '../../engine/fx';
import type { LegSpec } from '../../engine/types';
import type { FundingEvidence } from './evidence';
import { borrowEvidence, marginBlocker, positionBlockers, quoteOf, type Blocker, type LedgerView } from './gates';
import { candidateIdOf, CURRENCY, type PreviewContent, type PreviewRequest } from './request';

export interface DealPlan {
  a: LegSpec;
  b: LegSpec;
  makerLeg: Side;
  qty: string;
  price: string;
  timeoutSec: number;
  leverage: { a: string; b: string };
  /** Signed nets read this round, the slice baseline for untracked contracts. */
  observed: Record<string, string>;
}

export interface Judgement { content: PreviewContent; blockers: Blocker[]; scenario: FundingScenario | null; plan: DealPlan | null }

const OTHER: Record<Side, Side> = { short: 'long', long: 'short' };
const SIDE: Record<Side, 'BUY' | 'SELL'> = { short: 'SELL', long: 'BUY' };

/** Rule values arrive as strings, numbers or sci-notation; null when unusable. */
function dec(v: unknown): string | null {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < 0) return null;
  return n === 0 ? '0' : n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

function display(amount: Amount, places: number): string | null {
  if (amount.status !== 'known') return null;
  const e = exact(amount.value)!;
  return divideRounded(e.n * 10n ** BigInt(places), e.d, places);
}

function payback(p: Payback): string {
  if (p.kind !== 'days') return p.kind;
  return display({ status: 'known', value: p.days }, 1)!;
}

const ACKNOWLEDGED = [
  'maker-expiry-converts-remainder-to-taker',
  'taker-ioc-has-no-price-or-cost-cap',
  'one-leg-exposure-until-hedged',
  'trading-permission-inferred-from-signed-reads',
  'risk-exempts-only-reconciled-floating-quantity',
];

interface Sizing { qty: string | null; rounding: string | null; specs: Record<Side, LegSpec> | null }

function size(req: PreviewRequest, rules: Record<Side, RuleSymbol | null>, out: Blocker[]): Sizing {
  const specs = {} as Record<Side, LegSpec>;
  for (const side of ['short', 'long'] as const) {
    const r = rules[side];
    const symbol = req[side].symbol;
    if (!r) { out.push({ code: 'rules-unknown', message: `${symbol} rules could not be read` }); continue; }
    if (r.state !== 'live' || r.businessType !== 'FUTURE') { out.push({ code: 'rules-not-tradable', message: `${symbol} is ${r.state} ${r.businessType}` }); continue; }
    const [lot, minSize, minNotional, tick] = [dec(r.lotSize), dec(r.minSize), dec(r.minNotional), dec(r.tickSize)];
    if (!lot || fx(lot) <= 0n || minSize === null || minNotional === null || !tick) { out.push({ code: 'rules-invalid', message: `${symbol} has unusable size rules` }); continue; }
    specs[side] = { contract: symbol, side: SIDE[side], lot, minSize, minNotional, tick };
  }
  if (!specs.short || !specs.long) return { qty: null, rounding: null, specs: null };
  const [la, lb] = [fx(specs.short.lot), fx(specs.long.lot)];
  const step = la >= lb ? la : lb;
  if (step % (la >= lb ? lb : la) !== 0n) {
    out.push({ code: 'lot-incompatible', message: `lots ${specs.short.lot} and ${specs.long.lot} share no common step` });
    return { qty: null, rounding: null, specs };
  }
  const input = fx(req.quantity);
  const qty = fxFloorToStep(input, step);
  const rounding = qty === input ? null : `floored from ${req.quantity} to ${fxStr(qty)}: both legs trade in steps of ${fxStr(step)}`;
  if (qty <= 0n) {
    out.push({ code: 'quantity-below-lot', message: `${req.quantity} is below one step of ${fxStr(step)}` });
    return { qty: null, rounding, specs };
  }
  for (const side of ['short', 'long'] as const) {
    const r = rules[side]!;
    if (qty < fx(specs[side].minSize)) out.push({ code: 'quantity-below-minimum', message: `${fxStr(qty)} is below ${r.symbol}'s minimum ${specs[side].minSize}` });
    const caps = [dec(r.maxMarketSize), ...(side === req.makerLeg ? [dec(r.maxLimitSize)] : [])];
    if (caps.some((c) => c !== null && fx(c) > 0n && qty > fx(c))) out.push({ code: 'quantity-above-maximum', message: `${fxStr(qty)} exceeds ${r.symbol}'s maximum order size` });
  }
  return { qty: fxStr(qty), rounding, specs };
}

function makerPrice(req: PreviewRequest, ev: FundingEvidence, spec: LegSpec | undefined): string | null {
  const book = ev.costs[req.makerLeg].book;
  const raw = req.makerPrice ?? (book.status !== 'known' ? null : (SIDE[req.makerLeg] === 'BUY' ? book.bids[0]?.[0] : book.asks[0]?.[0]) ?? null);
  if (raw === null || !spec) return null;
  return formatRestPrice(Number(raw), SIDE[req.makerLeg], spec.contract, spec.tick);
}

export function judge(req: PreviewRequest, ev: FundingEvidence, ledger: LedgerView, admission: AdmissionState): Judgement {
  const blockers: Blocker[] = [];
  if (!admission.open) blockers.push({ code: 'admission-closed', message: `new funding opens are not admitted (${admission.reason})` });
  if (!ev.history.admitted) blockers.push({ code: ev.history.reason, message: 'the selected history window is not admissible now' });
  for (const side of ['short', 'long'] as const) {
    const l = ev.legs[side];
    if (!l || l.venue !== req[side].venue || l.contractId !== req[side].contractId) {
      blockers.push({ code: 'symbol-unmapped', message: `${req[side].symbol} is not proven to trade ${req[side].venue} ${req[side].contractId}` });
    }
    const { base } = parseSymbol(req[side].symbol);
    const { underlying, multiplier } = underlyingOf(base);
    if (multiplier !== 1 || underlying !== req.underlying || !(SUPPORTED_COINS as readonly string[]).includes(underlying)) {
      blockers.push({ code: 'unit-unsupported', message: `${req[side].symbol} is not a one-${req.underlying} contract of a supported coin` });
    }
  }
  const ruleOf = (symbol: string) => ev.rules?.find((r) => r.symbol?.toUpperCase() === symbol) ?? null;
  const sizing = size(req, { short: ruleOf(req.short.symbol), long: ruleOf(req.long.symbol) }, blockers);
  const price = makerPrice(req, ev, sizing.specs?.[req.makerLeg]);
  if (price === null) blockers.push({ code: 'maker-price-unknown', message: 'no maker price: the maker book could not be read' });

  const fees = { short: ev.costs.short.fees, long: ev.costs.long.fees };
  for (const side of ['short', 'long'] as const) {
    if (fees[side].status !== 'known') blockers.push({ code: 'fees-unknown', message: `${req[side].symbol} account fee rate is unknown` });
    const max = ev.leverageMax?.get(req[side].symbol);
    if (max === undefined || !(max > 0)) blockers.push({ code: 'leverage-unknown', message: `${req[side].symbol} leverage limit could not be read` });
    else if (Number(req.leverage[side]) > max) blockers.push({ code: 'leverage-above-maximum', message: `${req[side].symbol} allows at most ${max}x` });
  }
  if (ev.fx === null) blockers.push({ code: 'fx-unknown', message: `no fresh rate into ${CURRENCY} for these quotes` });
  const quotes = [...new Set([quoteOf(req.short.symbol), quoteOf(req.long.symbol)])];
  const borrow = borrowEvidence(ev.account, ev.interest, quotes, ev.readAt);
  if (borrow.status === 'unknown') blockers.push({ code: 'borrow-unknown', message: `borrow carry is unknown (${borrow.reason})` });
  blockers.push(...positionBlockers({ short: req.short.symbol, long: req.long.symbol }, ev.positions, ev.openOrders, ledger));
  const current = (side: Side) => {
    const v = ev.leverage?.[req[side].symbol];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
  };
  if (!ev.leverage) blockers.push({ code: 'leverage-unread', message: 'current leverage could not be read (signed read failed)' });

  let scenario: FundingScenario | null = null;
  if (sizing.qty && price && ev.history.admitted) {
    const result = ev.history.result;
    try {
      scenario = estimateFundingScenario({
        quantity: sizing.qty, holdDays: req.holdDays, currency: CURRENCY, windowDays: req.windowDays, makerLeg: req.makerLeg, makerPrice: price,
        short: { symbol: req.short.symbol, fundingTotal: result.short.total, ...ev.costs.short },
        long: { symbol: req.long.symbol, fundingTotal: result.long.total, ...ev.costs.long },
        fx: ev.fx ?? [], borrow,
        conversion: { status: 'not-applicable', evidence: 'the deal trades perpetuals only; no currency is converted', source: 'engine deal shape', at: ev.readAt, basis: 'real' },
      });
    } catch {
      blockers.push({ code: 'scenario-invalid', message: 'the scenario inputs are invalid' });
    }
  }
  for (const reason of scenario?.unknown ?? []) blockers.push({ code: 'scenario-unknown', message: reason });
  if (scenario) {
    const takers = fees.short.status === 'known' && fees.long.status === 'known' ? { short: fees.short.taker, long: fees.long.taker } : null;
    const margin = marginBlocker(ev.account, scenario, req.leverage, takers);
    if (margin) blockers.push(margin);
    for (const side of ['short', 'long'] as const) {
      // In the leg's own quote, as the venue checks it.
      const mid = scenario.legs[side].mid;
      const min = sizing.specs?.[side].minNotional;
      if (mid.status === 'known' && min && fx(min) > 0n && cmp(mul(exact(sizing.qty!)!, exact(mid.value)!), exact(min)!) < 0) {
        blockers.push({ code: 'quantity-below-min-notional', message: `${req[side].symbol} needs at least ${min} notional` });
      }
    }
  }

  const warnings = [...ACKNOWLEDGED];
  for (const side of ['short', 'long'] as const) {
    const now = current(side);
    if (now !== null && Number(now) !== Number(req.leverage[side])) warnings.push(`leverage-change:${req[side].symbol}:${now}->${req.leverage[side]}`);
  }
  const normalHold = scenario ? display(scenario.normal.holdResult, 2) : null;
  const daily = scenario ? display(scenario.daily, 2) : null;
  if ((daily !== null && sign(exact(daily)!) <= 0) || (normalHold !== null && sign(exact(normalHold)!) <= 0)) warnings.push('scenario-not-positive');

  const legView = (side: Side) => ({ ...req[side], side: SIDE[side], role: side === req.makerLeg ? 'maker' as const : 'hedge' as const, leverage: req.leverage[side] });
  const feeView = (side: Side) => { const f = fees[side]; return f.status === 'known' ? { maker: f.maker, taker: f.taker } : null; };
  const content: PreviewContent = {
    candidateId: candidateIdOf(req), underlying: req.underlying, snapshotId: req.snapshotId,
    cutoff: ev.history.admitted ? ev.history.result.cutoff : null, windowDays: req.windowDays,
    legs: { short: legView('short'), long: legView('long') },
    quantityInput: req.quantity, quantity: sizing.qty, rounding: sizing.rounding, makerPrice: price,
    timeoutSec: req.timeoutSec, onExpiry: 'convert-to-taker', holdDays: req.holdDays, currency: CURRENCY,
    fees: { short: feeView('short'), long: feeView('long') },
    fx: ev.fx === null ? 'unknown' : ev.fx.length ? ev.fx.map((r) => `${r.from}/${r.to} ${r.rate}`).join('; ') : 'none',
    borrow: borrow.status === 'known' ? `${borrow.principal} ${borrow.currency} at ${borrow.dailyRate}/day` : borrow.status,
    amounts: {
      normalOneTime: scenario ? display(scenario.normal.oneTime, 2) : null,
      conversionOneTime: scenario ? display(scenario.conversion.oneTime, 2) : null,
      daily, normalHold, conversionHold: scenario ? display(scenario.conversion.holdResult, 2) : null,
    },
    payback: { normal: scenario ? payback(scenario.normal.payback) : 'unknown', conversion: scenario ? payback(scenario.conversion.payback) : 'unknown' },
    warnings,
  };
  const ok = !blockers.length && sizing.specs && sizing.qty && price && ev.positions;
  const plan: DealPlan | null = ok ? {
    a: sizing.specs![req.makerLeg], b: sizing.specs![OTHER[req.makerLeg]], makerLeg: req.makerLeg, qty: sizing.qty!, price: price!,
    timeoutSec: req.timeoutSec, leverage: { a: req.leverage[req.makerLeg], b: req.leverage[OTHER[req.makerLeg]] },
    observed: Object.fromEntries([req.short.symbol, req.long.symbol].map((c) => [c, ev.positions!.get(c) ?? '0'])),
  } : null;
  return { content, blockers, scenario, plan };
}
