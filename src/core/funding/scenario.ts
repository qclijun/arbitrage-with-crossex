/**
 * Size-dependent costs and a holding-period scenario for one directed funding
 * candidate. The same underlying quantity is hedged on both legs; each leg's
 * notional is priced on its own book and converted to one declared currency.
 * Every amount stays exact until display and is UNKNOWN, never zero, when its
 * evidence is missing. A scenario is an estimate under stated assumptions, not
 * realized profit, and it never feeds back into the historical rank. Pure.
 */
import { parseSymbol } from '../numbers';
import { HISTORY_DAYS, type HistoryDays } from './history';
import { ZERO, add, cmp, decimal, div, exact, mul, sign, sub, sum, type Exact } from './exact';

export interface CostSource {
  source: string;
  /** When the evidence was read (or stated); null when the source gives none. */
  at: number | null;
  basis: 'real' | 'assumed';
}

export interface Unknown { status: 'unknown'; reason: string }
export type NotApplicable = { status: 'not-applicable'; evidence: string } & CostSource;

export type FeeRates = { maker: string; taker: string } & CostSource;
/** An unknown account rate may carry an assumed tier (VIP0) as a labeled reference only. */
export type FeeEvidence = ({ status: 'known' } & FeeRates) | (Unknown & { reference: FeeRates | null });

/** [price, base quantity] as decimal strings, in the leg's quote currency. */
export type Level = [string, string];
export type BookEvidence = ({ status: 'known'; bids: Level[]; asks: Level[] } & CostSource) | Unknown;

/** 1 `from` buys `rate` `to`. Stablecoins are separate currencies: USDT and USDC need a rate. */
export interface FxRate extends CostSource { from: string; to: string; rate: string }

export type BorrowEvidence =
  | ({ status: 'known'; currency: string; principal: string; dailyRate: string } & CostSource)
  | NotApplicable
  | Unknown;
export type ConversionEvidence = ({ status: 'known'; currency: string; amount: string } & CostSource) | NotApplicable | Unknown;

export interface ScenarioLeg {
  /** Exact CrossEx symbol; its quote is the leg's price currency. */
  symbol: string;
  /** Signed settled-rate total of the selected window; null unless that window is complete. */
  fundingTotal: string | null;
  fees: FeeEvidence;
  book: BookEvidence;
}

export type Side = 'short' | 'long';

export interface ScenarioInput {
  /** Underlying quantity, the same on both legs. */
  quantity: string;
  /** H, the user's holding period. */
  holdDays: string;
  /** The common currency every amount is converted to. */
  currency: string;
  windowDays: HistoryDays;
  /** Leg A, opened by a resting maker; the other leg is the taker hedge. */
  makerLeg: Side;
  /** Leg A's limit price; defaults to its own-side touch. */
  makerPrice?: string;
  short: ScenarioLeg;
  long: ScenarioLeg;
  fx: FxRate[];
  borrow: BorrowEvidence;
  conversion: ConversionEvidence;
}

export type Amount = { status: 'known'; value: string } | { status: 'unknown'; reasons: string[] };

export interface CostLine {
  item: 'fee' | 'book' | 'borrow' | 'conversion';
  leg: Side | null;
  phase: 'open' | 'close' | 'hold';
  role: 'maker' | 'taker' | null;
  nature: 'one-time' | 'daily';
  /** Signed cost in the common currency; negative is a rebate or a fill better than the reference mid. */
  amount: Amount;
  /** Fee rate, or average fill price in the leg's quote. */
  rate: string | null;
  source: string | null;
  at: number | null;
  basis: CostSource['basis'] | null;
  /** Why a cost does not apply, when it has evidence for that. */
  notApplicable: string | null;
}

export type Payback =
  | { kind: 'unknown'; reasons: string[] }
  /** D ≤ 0: no finite payback, whatever the historical spread. */
  | { kind: 'none' }
  /** D > 0 and C ≤ 0; the future can still lose. */
  | { kind: 'not-needed' }
  | { kind: 'days'; days: string };

export interface PathResult {
  lines: CostLine[];
  /** C: every one-time cost of this path. */
  oneTime: Amount;
  /** H × D − C. */
  holdResult: Amount;
  payback: Payback;
}

export interface LegResult {
  symbol: string;
  quote: string;
  /** Reference mid in the leg's quote. */
  mid: Amount;
  /** Quote-to-common rate applied, with its source. */
  fx: (FxRate & { status: 'known' }) | { status: 'unknown'; reasons: string[] };
  notional: Amount;
  /** Signed daily funding income on this leg's notional. */
  fundingDaily: Amount;
}

export interface FundingScenario {
  currency: string;
  quantity: string;
  holdDays: string;
  windowDays: HistoryDays;
  makerLeg: Side;
  legs: Record<Side, LegResult>;
  /** G_day: Σ leg funding at the window's average rate. */
  grossDaily: Amount;
  carry: CostLine;
  /** D = G_day − daily carry. */
  daily: Amount;
  /** The normal path: maker A, taker hedge B, both legs closed by taker. */
  normal: PathResult;
  /** Leg A expires unfilled and converts to taker on the whole quantity: a reference, not a cost cap. */
  conversion: PathResult & { fullQuantity: true };
  /** Real fees unknown: the same paths at the assumed reference tier, labeled, never admission evidence. */
  assumedReference: { normal: PathResult; conversion: PathResult } | null;
  /** Every reason a required amount is unknown; any one blocks an order. */
  unknown: string[];
  assumptions: readonly string[];
}

export const SCENARIO_ASSUMPTIONS = [
  'historical-average-rates-persist',
  'current-book-fees-and-carry-not-guaranteed',
  'basis-price-and-fx-paths-not-modeled',
  'not-realized-net-profit',
  'conversion-full-quantity-reference-not-a-cap',
] as const;

type Value = Exact | string[];
const known = (v: Value): v is Exact => !Array.isArray(v);
const reasonsOf = (values: Value[]): string[] => [...new Set(values.flatMap((v) => (known(v) ? [] : v)))];
const amount = (v: Value): Amount => (known(v) ? { status: 'known', value: decimal(v) } : { status: 'unknown', reasons: v });
const total = (values: Value[]): Value => {
  const reasons = reasonsOf(values);
  return reasons.length ? reasons : sum(values as Exact[]);
};
const product = (values: Value[]): Value => {
  const reasons = reasonsOf(values);
  return reasons.length ? reasons : (values as Exact[]).reduce(mul);
};
const minus = (a: Value, b: Value): Value => (known(a) && known(b) ? sub(a, b) : reasonsOf([a, b]));

function positive(value: string | undefined): Exact | null {
  const v = value === undefined ? null : exact(value);
  return v && sign(v) > 0 ? v : null;
}

const OTHER: Record<Side, Side> = { short: 'long', long: 'short' };
/** Opening a short sells; closing it buys. */
const OPEN_BUYS: Record<Side, boolean> = { short: false, long: true };

interface Book { bids: Array<[Exact, Exact]>; asks: Array<[Exact, Exact]>; mid: Exact; src: CostSource }

function readBook(evidence: BookEvidence, side: Side): Book | string[] {
  if (evidence.status !== 'known') return [`${side}:book-${evidence.reason}`];
  const levels = (rows: Level[]): Array<[Exact, Exact]> | null => {
    const out: Array<[Exact, Exact]> = [];
    for (const [price, size] of rows) {
      const p = positive(price);
      const q = positive(size);
      if (!p || !q) return null;
      out.push([p, q]);
    }
    return out;
  };
  const bids = levels(evidence.bids);
  const asks = levels(evidence.asks);
  if (!bids || !asks) return [`${side}:book-invalid`];
  const b = bids.sort((x, y) => cmp(y[0], x[0]));
  const a = asks.sort((x, y) => cmp(x[0], y[0]));
  if (!b.length || !a.length) return [`${side}:book-one-sided`];
  if (cmp(b[0][0], a[0][0]) > 0) return [`${side}:book-crossed`];
  return { bids: b, asks: a, mid: div(add(b[0][0], a[0][0]), { n: 2n, d: 1n }), src: evidence };
}

/** Average price for the whole quantity; a book thinner than it is not extrapolated past its last level. */
function walk(levels: Array<[Exact, Exact]>, qty: Exact): Exact | null {
  let remaining = qty;
  let cost = ZERO;
  for (const [price, size] of levels) {
    const take = cmp(remaining, size) < 0 ? remaining : size;
    cost = add(cost, mul(take, price));
    remaining = sub(remaining, take);
    if (sign(remaining) === 0) return div(cost, qty);
  }
  return null;
}

function fxRate(rates: FxRate[], from: string, to: string, label: string): LegResult['fx'] {
  if (from === to) return { status: 'known', from, to, rate: '1', source: 'same currency', at: null, basis: 'real' };
  const matches = rates.filter((r) => r.from === from && r.to === to);
  const values = new Set(matches.map((r) => (positive(r.rate) ? decimal(positive(r.rate)!) : 'invalid')));
  if (!matches.length) return { status: 'unknown', reasons: [`${label}:fx-missing:${from}/${to}`] };
  if (values.size !== 1 || values.has('invalid')) return { status: 'unknown', reasons: [`${label}:fx-unverified:${from}/${to}`] };
  return { status: 'known', ...matches[0] };
}

const fxValue = (fx: LegResult['fx']): Value => (fx.status === 'known' ? exact(fx.rate)! : fx.reasons);

function line(base: Omit<CostLine, 'amount' | 'rate' | 'source' | 'at' | 'basis' | 'notApplicable'>, value: Value,
  src: Partial<CostSource> | null, rate: string | null = null, notApplicable: string | null = null): CostLine & { value: Value } {
  return { ...base, amount: amount(value), rate, source: src?.source ?? null, at: src?.at ?? null,
    basis: src?.basis ?? null, notApplicable, value };
}

interface Context {
  input: ScenarioInput;
  qty: Exact;
  makerPrice: Exact | null;
  books: Record<Side, Book | string[]>;
  fx: Record<Side, Value>;
}

/** One fill: its fee line and its price-impact line against the leg's mid, both in the common currency. */
function fill(ctx: Context, side: Side, phase: 'open' | 'close', role: 'maker' | 'taker', fees: FeeEvidence): Array<CostLine & { value: Value }> {
  const buys = phase === 'open' ? OPEN_BUYS[side] : !OPEN_BUYS[side];
  const book = ctx.books[side];
  const fx = ctx.fx[side];
  const price: Value = Array.isArray(book) ? book
    : role === 'maker' ? ctx.makerPrice ?? (buys ? book.bids[0][0] : book.asks[0][0])
      : walk(buys ? book.asks : book.bids, ctx.qty) ?? [`${side}:${phase}:depth-insufficient`];
  const rateText = fees.status === 'known' ? fees[role] : null;
  const rate: Value = fees.status !== 'known' ? [`${side}:fee-${fees.reason}`] : exact(fees[role]) ?? [`${side}:fee-invalid`];
  const base = { leg: side, phase, role, nature: 'one-time' as const };
  const fee = product([rate, ctx.qty, price, fx]);
  // Signed against the taker: buying above the mid, or selling below it, costs.
  const paid = Array.isArray(book) ? book : buys ? minus(price, book.mid) : minus(book.mid, price);
  const impact = product([paid, ctx.qty, fx]);
  return [
    line({ ...base, item: 'fee' }, fee, fees.status === 'known' ? fees : null, rateText),
    line({ ...base, item: 'book' }, impact, Array.isArray(book) ? null : book.src, known(price) ? decimal(price) : null),
  ];
}

function path(ctx: Context, fees: Record<Side, FeeEvidence>, aRole: 'maker' | 'taker', daily: Value, conversion: CostLine & { value: Value }): PathResult {
  const a = ctx.input.makerLeg;
  const b = OTHER[a];
  const lines = [
    ...fill(ctx, a, 'open', aRole, fees[a]),
    ...fill(ctx, b, 'open', 'taker', fees[b]),
    ...fill(ctx, 'short', 'close', 'taker', fees.short),
    ...fill(ctx, 'long', 'close', 'taker', fees.long),
    conversion,
  ];
  const c = total(lines.map((l) => l.value));
  const hold: Value = known(c) && known(daily) ? sub(mul(exact(ctx.input.holdDays)!, daily), c) : reasonsOf([daily, c]);
  let payback: Payback;
  if (!known(c) || !known(daily)) payback = { kind: 'unknown', reasons: reasonsOf([daily, c]) };
  else if (sign(daily) <= 0) payback = { kind: 'none' };
  else if (sign(c) <= 0) payback = { kind: 'not-needed' };
  else payback = { kind: 'days', days: decimal(div(c, daily)) };
  return { lines: lines.map(({ value: _v, ...rest }) => rest), oneTime: amount(c), holdResult: amount(hold), payback };
}

function evidenceLine(ev: BorrowEvidence | ConversionEvidence, item: 'borrow' | 'conversion', rates: FxRate[], currency: string): CostLine & { value: Value } {
  const base = { item, leg: null, phase: item === 'borrow' ? 'hold' as const : 'open' as const, role: null,
    nature: item === 'borrow' ? 'daily' as const : 'one-time' as const };
  if (ev.status === 'unknown') return line(base, [`${item}-${ev.reason}`], null);
  if (ev.status === 'not-applicable') {
    return ev.evidence ? line(base, ZERO, ev, null, ev.evidence) : line(base, [`${item}-not-applicable-unproven`], null);
  }
  const raw = ev.status === 'known' && 'principal' in ev
    ? (() => {
      const p = exact(ev.principal);
      const r = exact(ev.dailyRate);
      return p && r ? mul(p, r) : null;
    })()
    : exact((ev as { amount: string }).amount);
  const fx = fxValue(fxRate(rates, ev.currency, currency, item));
  const value: Value = raw ? (known(fx) ? mul(raw, fx) : fx) : [`${item}-invalid`];
  return line(base, value, ev, 'dailyRate' in ev ? ev.dailyRate : null);
}

export function estimateFundingScenario(input: ScenarioInput): FundingScenario {
  const qty = positive(input.quantity);
  const hold = positive(input.holdDays);
  if (!qty || !hold || !input.currency || !HISTORY_DAYS.includes(input.windowDays)
    || (input.makerLeg !== 'short' && input.makerLeg !== 'long')
    || (input.makerPrice !== undefined && !positive(input.makerPrice))) throw new Error('Invalid scenario input');
  const sides: Side[] = ['short', 'long'];
  const fxBySide = {} as Record<Side, LegResult['fx']>;
  const makerPrice = input.makerPrice === undefined ? null : positive(input.makerPrice);
  const ctx: Context = { input, qty, makerPrice, books: {} as Context['books'], fx: {} as Context['fx'] };
  const legs = {} as Record<Side, LegResult & { daily: Value }>;
  for (const side of sides) {
    const leg = input[side];
    const { quote } = parseSymbol(leg.symbol.toUpperCase());
    fxBySide[side] = fxRate(input.fx, quote, input.currency, side);
    ctx.books[side] = readBook(leg.book, side);
    ctx.fx[side] = fxValue(fxBySide[side]);
    const book = ctx.books[side];
    const mid: Value = Array.isArray(book) ? book : book.mid;
    const notional = product([qty, mid, ctx.fx[side]]);
    const rate = leg.fundingTotal === null ? null : exact(leg.fundingTotal);
    // The short receives a positive rate on its notional; the long pays it.
    const perDay: Value = rate ? div(rate, { n: BigInt(side === 'short' ? input.windowDays : -input.windowDays), d: 1n }) : [`${side}:history-unavailable`];
    const daily = product([notional, perDay]);
    legs[side] = { symbol: leg.symbol, quote, mid: amount(mid), fx: fxBySide[side], notional: amount(notional), fundingDaily: amount(daily), daily };
  }
  const gross = total([legs.short.daily, legs.long.daily]);
  const carry = evidenceLine(input.borrow, 'borrow', input.fx, input.currency);
  const daily = minus(gross, carry.value);
  const conversion = evidenceLine(input.conversion, 'conversion', input.fx, input.currency);
  const real = { short: input.short.fees, long: input.long.fees };
  const normal = path(ctx, real, 'maker', daily, conversion);
  const converted = path(ctx, real, 'taker', daily, conversion);
  const unknownFees = sides.filter((s) => real[s].status !== 'known');
  let assumedReference: FundingScenario['assumedReference'] = null;
  if (unknownFees.length && unknownFees.every((s) => {
    const fee = real[s];
    return fee.status === 'unknown' && fee.reference;
  })) {
    const assumed = Object.fromEntries(sides.map((s) => {
      const fee = real[s];
      return [s, fee.status === 'known' ? fee : { status: 'known', ...fee.reference! }];
    })) as Record<Side, FeeEvidence>;
    assumedReference = { normal: path(ctx, assumed, 'maker', daily, conversion), conversion: path(ctx, assumed, 'taker', daily, conversion) };
  }
  const reasons = (p: PathResult) => (p.payback.kind === 'unknown' ? p.payback.reasons : []);
  const strip = ({ daily: _d, ...rest }: LegResult & { daily: Value }): LegResult => rest;
  const { value: _c, ...carryLine } = carry;
  return {
    currency: input.currency,
    quantity: input.quantity,
    holdDays: input.holdDays,
    windowDays: input.windowDays,
    makerLeg: input.makerLeg,
    legs: { short: strip(legs.short), long: strip(legs.long) },
    grossDaily: amount(gross),
    carry: carryLine,
    daily: amount(daily),
    normal,
    conversion: { ...converted, fullQuantity: true },
    assumedReference,
    unknown: [...new Set([...reasons(normal), ...reasons(converted)])],
    assumptions: SCENARIO_ASSUMPTIONS,
  };
}
