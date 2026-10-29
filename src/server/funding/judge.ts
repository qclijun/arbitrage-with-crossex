/**
 * Judge one funding preview request against one evidence round (ticket 12).
 * Pure. Produces what the user would confirm (content.ts), every reason it
 * cannot be accepted now, and — only when there is none — the exact deal the
 * engine would run. The same function judges the preview and, on fresh
 * evidence, the acceptance; their contents must match.
 */
import { SUPPORTED_COINS } from '../../core/coins';
import { cmp, exact, mul } from '../../core/funding/exact';
import { underlyingOf } from '../../core/funding/spreads';
import { estimateFundingScenario, type BorrowEvidence, type FundingScenario, type Side } from '../../core/funding/scenario';
import { parseSymbol } from '../../core/numbers';
import type { AdmissionState } from '../../engine/admission';
import { fx } from '../../engine/fx';
import type { LegSpec } from '../../engine/types';
import { contentOf } from './content';
import type { FundingEvidence } from './evidence';
import { borrowEvidence, marginBlocker, positionBlockers, quoteOf, type Blocker, type LedgerView } from './gates';
import { currencyOf, type PreviewContent, type PreviewRequest } from './request';
import { makerPrice, size, type Sizing } from './sizing';

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

const SIDES = ['short', 'long'] as const;
const OTHER: Record<Side, Side> = { short: 'long', long: 'short' };

/** The candidate itself: admission, history, contract identity and unit. */
function candidateBlockers(req: PreviewRequest, ev: FundingEvidence, admission: AdmissionState): Blocker[] {
  const out: Blocker[] = [];
  if (!admission.open) out.push({ code: 'admission-closed', message: `new funding opens are not admitted (${admission.reason})` });
  if (!ev.history.admitted) out.push({ code: ev.history.reason, message: 'the selected history window is not admissible now' });
  for (const side of SIDES) {
    const { symbol, venue, contractId } = req[side];
    const proven = ev.legs[side];
    if (!proven || proven.venue !== venue || proven.contractId !== contractId) {
      out.push({ code: 'symbol-unmapped', message: `${symbol} is not proven to trade ${venue} ${contractId}` });
    }
    const { underlying, multiplier } = underlyingOf(parseSymbol(symbol).base);
    if (multiplier !== 1 || underlying !== req.underlying || !(SUPPORTED_COINS as readonly string[]).includes(underlying)) {
      out.push({ code: 'unit-unsupported', message: `${symbol} is not a one-${req.underlying} contract of a supported coin` });
    }
  }
  return out;
}

/** Fees, leverage limits, FX and borrow evidence for both legs. */
function costBlockers(req: PreviewRequest, ev: FundingEvidence, borrow: BorrowEvidence): Blocker[] {
  const out: Blocker[] = [];
  for (const side of SIDES) {
    const { symbol } = req[side];
    if (ev.costs[side].fees.status !== 'known') out.push({ code: 'fees-unknown', message: `${symbol} account fee rate is unknown` });
    const max = ev.leverageMax?.get(symbol);
    if (max === undefined || !(max > 0)) out.push({ code: 'leverage-unknown', message: `${symbol} leverage limit could not be read` });
    else if (Number(req.leverage[side]) > max) out.push({ code: 'leverage-above-maximum', message: `${symbol} allows at most ${max}x` });
  }
  if (!ev.leverage) out.push({ code: 'leverage-unread', message: 'current leverage could not be read (signed read failed)' });
  if (ev.fx === null) out.push({ code: 'fx-unknown', message: `no fresh, current rate into ${currencyOf(req)} for these quotes` });
  if (borrow.status === 'unknown') out.push({ code: 'borrow-unknown', message: `borrow carry is unknown (${borrow.reason})` });
  return out;
}

function scenarioOf(
  req: PreviewRequest, ev: FundingEvidence, sizing: Sizing, price: string | null, borrow: BorrowEvidence,
): FundingScenario | null {
  if (!sizing.qty || !price || !ev.history.admitted) return null;
  const { short, long } = ev.history.result;
  try {
    return estimateFundingScenario({
      quantity: sizing.qty, holdDays: req.holdDays, currency: currencyOf(req), windowDays: req.windowDays,
      makerLeg: req.makerLeg, makerPrice: price,
      short: { symbol: req.short.symbol, fundingTotal: short.total, ...ev.costs.short },
      long: { symbol: req.long.symbol, fundingTotal: long.total, ...ev.costs.long },
      fx: ev.fx ?? [], borrow,
      conversion: { status: 'not-applicable', evidence: 'the deal trades perpetuals only; no currency is converted',
        source: 'engine deal shape', at: ev.readAt, basis: 'real' },
    });
  } catch {
    return null;
  }
}

/** What the scenario's numbers refuse: unknown amounts, margin, minimum notional. */
function scenarioBlockers(req: PreviewRequest, ev: FundingEvidence, sizing: Sizing, scenario: FundingScenario): Blocker[] {
  const out: Blocker[] = scenario.unknown.map((reason) => ({ code: 'scenario-unknown', message: reason }));
  const { short, long } = ev.costs;
  const takers = short.fees.status === 'known' && long.fees.status === 'known' ? { short: short.fees.taker, long: long.fees.taker } : null;
  const margin = marginBlocker(ev.account, scenario, req.leverage, takers);
  if (margin) out.push(margin);
  for (const side of SIDES) {
    // In the leg's own quote, as the venue checks it.
    const mid = scenario.legs[side].mid;
    const min = sizing.specs![side].minNotional;
    if (mid.status === 'known' && fx(min) > 0n && cmp(mul(exact(sizing.qty!)!, exact(mid.value)!), exact(min)!) < 0) {
      out.push({ code: 'quantity-below-min-notional', message: `${req[side].symbol} needs at least ${min} notional` });
    }
  }
  return out;
}

export function judge(req: PreviewRequest, ev: FundingEvidence, ledger: LedgerView, admission: AdmissionState): Judgement {
  const blockers = candidateBlockers(req, ev, admission);
  const rule = (symbol: string) => ev.rules?.find((r) => r.symbol?.toUpperCase() === symbol) ?? null;
  const sizing = size(req, { short: rule(req.short.symbol), long: rule(req.long.symbol) }, blockers);
  const price = makerPrice(req, ev, sizing.specs?.[req.makerLeg]);
  if (price === null) blockers.push({ code: 'maker-price-unknown', message: 'no maker price: the maker book could not be read' });
  const quotes = [...new Set(SIDES.map((side) => quoteOf(req[side].symbol)))];
  const borrow = borrowEvidence(ev.account, ev.interest, quotes, ev.readAt);
  blockers.push(...costBlockers(req, ev, borrow));
  blockers.push(...positionBlockers({ short: req.short.symbol, long: req.long.symbol }, ev.positions, ev.openOrders, ledger));
  const scenario = scenarioOf(req, ev, sizing, price, borrow);
  if (scenario) blockers.push(...scenarioBlockers(req, ev, sizing, scenario));
  else if (sizing.qty && price && ev.history.admitted) {
    blockers.push({ code: 'scenario-invalid', message: 'the scenario inputs are invalid' });
  }

  const content = contentOf({ req, ev, sizing, price, currency: currencyOf(req), borrow, scenario });
  const plan: DealPlan | null = blockers.length || !sizing.specs || !sizing.qty || !price || !ev.positions ? null : {
    a: sizing.specs[req.makerLeg], b: sizing.specs[OTHER[req.makerLeg]], makerLeg: req.makerLeg, qty: sizing.qty, price,
    timeoutSec: req.timeoutSec, leverage: { a: req.leverage[req.makerLeg], b: req.leverage[OTHER[req.makerLeg]] },
    observed: Object.fromEntries(SIDES.map((side) => [req[side].symbol, ev.positions!.get(req[side].symbol) ?? '0'])),
  };
  return { content, blockers, scenario, plan };
}
