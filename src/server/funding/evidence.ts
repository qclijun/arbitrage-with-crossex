/**
 * One fresh, read-only evidence round for a funding preview or acceptance
 * (ticket 12). `readAt` is when the round began: everything it returns is at
 * most as old as that, and the 10 s acceptance limit runs from it. A failed
 * read is recorded as missing (null / UNKNOWN), never filled from a cache or
 * re-stamped. Nothing here writes anywhere.
 */
import type { CrossexAccount, CrossexInterestRate, Symbol as RuleSymbol } from 'gate-api';
import { readCostEvidence, type LegCostEvidence } from '../../core/funding/cost-evidence';
import type { HistoryAdmission, HistoryLegKey, HistoryPairRequest } from '../../core/funding/history-cache';
import { decimal, div, exact, sign } from '../../core/funding/exact';
import type { FxRate, Side } from '../../core/funding/scenario';
import { parseSymbol } from '../../core/numbers';
import { signedPositions } from '../livePositions';
import type { FundingReads } from './reads';
import { currencyOf, type PreviewRequest } from './request';

/** What the funding admission needs beyond the venue reads. */
export interface FundingPorts {
  history: { recheck(request: HistoryPairRequest & { snapshotId: string }, now: number): HistoryAdmission };
  /** The venue-native contract a CrossEx symbol trades; null when unproven. */
  legOf(symbol: string): HistoryLegKey | null;
  reads: FundingReads;
}

export interface FundingEvidence {
  readAt: number;
  history: HistoryAdmission;
  /** Each requested symbol's proven venue contract (null = unproven). */
  legs: Record<Side, HistoryLegKey | null>;
  rules: RuleSymbol[] | null;
  leverageMax: Map<string, number> | null;
  leverage: Record<string, unknown> | null;
  costs: Record<Side, LegCostEvidence>;
  account: CrossexAccount | null;
  interest: CrossexInterestRate[] | null;
  /** Signed net per contract (upper-case). */
  positions: Map<string, string> | null;
  /** Contracts with an open venue order. */
  openOrders: Set<string> | null;
  /** Rates into the common currency; null when one was needed and unread. */
  fx: FxRate[] | null;
}

const orNull = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

const FX_PAIR = 'USDC_USDT';
/** The FX book must carry its own time, within this of the round's start. */
const FX_MAX_AGE_MS = 10_000;

async function readFx(reads: FundingReads, req: PreviewRequest, readAt: number): Promise<FxRate[] | null> {
  const currency = currencyOf(req);
  const quotes = new Set([req.short.symbol, req.long.symbol].map((s) => parseSymbol(s).quote));
  if ([...quotes].every((q) => q === currency)) return [];
  if (![...quotes].every((q) => q === currency || q === 'USDC')) return null;
  try {
    const top = await reads.spotTop(FX_PAIR);
    const [bid, ask] = [exact(top.bid), exact(top.ask)];
    if (top.at === null || Math.abs(readAt - top.at) > FX_MAX_AGE_MS || !bid || !ask || sign(bid) <= 0 || sign(ask) <= 0) return null;
    const source = `Gate spot ${FX_PAIR} book top`;
    // Selling USDC earns the bid; buying it back pays the ask.
    return [
      { from: 'USDC', to: currency, rate: decimal(bid), source: `${source} (bid)`, at: top.at, basis: 'real' },
      { from: currency, to: 'USDC', rate: decimal(div({ n: 1n, d: 1n }, ask)), source: `${source} (1/ask)`, at: top.at, basis: 'real' },
    ];
  } catch {
    return null;
  }
}

export async function gatherEvidence(ports: FundingPorts, req: PreviewRequest, now: () => number): Promise<FundingEvidence> {
  const readAt = now();
  const symbols = [req.short.symbol, req.long.symbol];
  const { reads } = ports;
  const legs = { short: ports.legOf(req.short.symbol), long: ports.legOf(req.long.symbol) };
  const history = ports.history.recheck({
    underlying: req.underlying, days: req.windowDays, snapshotId: req.snapshotId,
    short: { venue: req.short.venue, contractId: req.short.contractId },
    long: { venue: req.long.venue, contractId: req.long.contractId },
  }, readAt);
  const [rules, leverageMax, leverage, costs, account, interest, positions, openOrders, fx] = await Promise.all([
    orNull(reads.rules(symbols)),
    orNull(reads.leverageMax(symbols)),
    orNull(reads.leverage(symbols)),
    readCostEvidence({ now: () => readAt, listFees: () => reads.fees(), fetchBook: reads.book },
      { short: req.short.symbol, long: req.long.symbol }),
    orNull(reads.account()),
    orNull(reads.interestRates()),
    orNull(reads.positions().then(signedPositions)),
    orNull(reads.openOrders().then(openOrderContracts)),
    readFx(reads, req, readAt),
  ]);
  const { readAt: _r, ...legCosts } = costs;
  return { readAt, history, legs, rules, leverageMax, leverage, costs: legCosts, account, interest, positions, openOrders, fx };
}

function openOrderContracts(body: unknown): Set<string> {
  if (!Array.isArray(body)) throw new Error('open orders came back unreadable');
  return new Set((body as Array<{ symbol?: string }>).map((o) => (o.symbol ?? '').toUpperCase()));
}
