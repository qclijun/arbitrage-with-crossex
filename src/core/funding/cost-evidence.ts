/**
 * Current cost evidence for a funding scenario: the account's CrossEx fee
 * rates and each leg's public book, read fresh and stamped with the moment the
 * read began. A failed or malformed read is UNKNOWN with its reason; the VIP0
 * schedule rides along only as a labeled assumption, never as the real rate.
 * Freshness limits and admission belong to the caller.
 */
import type { VenueBookResult } from '../estimate/books';
import { feeRowsForTier } from '../estimate/crossexFeeTiers';
import type { VenueFeeRow } from '../estimate/fees';
import { parseSymbol } from '../numbers';
import { exact } from './exact';
import type { BookEvidence, FeeEvidence, FeeRates, Level, Side } from './scenario';

function vip0(venue: string): FeeRates {
  const [row] = feeRowsForTier('vip0', [venue]);
  return { maker: row.futureMakerFee!, taker: row.futureTakerFee!, at: null, basis: 'assumed',
    source: 'Gate CrossEx fee schedule VIP0 (assumed tier, help/crossex/functional/49701)' };
}

/** `rows` is null when the account read failed. */
export function feeEvidence(rows: VenueFeeRow[] | null, symbol: string, read: { source: string; at: number }): FeeEvidence {
  const sym = symbol.toUpperCase();
  const { exchange } = parseSymbol(sym);
  const reference = vip0(exchange);
  if (!rows) return { status: 'unknown', reason: 'read-failed', reference };
  const row = rows.find((r) => (r.exchangeType ?? '').toUpperCase() === exchange);
  if (!row) return { status: 'unknown', reason: 'account-rate-missing', reference };
  const special = (row.specialFeeList ?? []).find((s) => s.symbol.toUpperCase() === sym);
  const maker = special ? special.makerFeeRate : row.futureMakerFee;
  const taker = special ? special.takerFeeRate : row.futureTakerFee;
  if (maker === undefined || taker === undefined || !exact(maker) || !exact(taker)) {
    return { status: 'unknown', reason: 'account-rate-invalid', reference };
  }
  return { status: 'known', maker, taker, at: read.at, basis: 'real',
    source: special ? `${read.source} special_fee_list` : read.source };
}

/**
 * Shortest round-trip decimal of a finite positive number, without exponent notation.
 * Venue books arrive already parsed to numbers (estimate/books.ts, shared with trading);
 * this recovers the decimal each level printed as, and exact maths starts from it.
 */
function decimalOf(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const text = String(value);
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const digits = `${m[1]}${m[2] ?? ''}`;
  const point = m[1].length + Number(m[3]);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${'0'.repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** `readAt` is when this read began, not when the book arrived. */
export function bookEvidence(result: VenueBookResult, venue: string, readAt: number): BookEvidence {
  if (!result.book) return { status: 'unknown', reason: result.failure?.category ?? 'unavailable' };
  const levels = (rows: Array<[number, number]>): Level[] | null => {
    const out: Level[] = [];
    for (const [price, qty] of rows) {
      const p = decimalOf(price);
      const q = decimalOf(qty);
      if (!p || !q) return null;
      out.push([p, q]);
    }
    return out;
  };
  const bids = levels(result.book.bids);
  const asks = levels(result.book.asks);
  if (!bids || !asks) return { status: 'unknown', reason: 'invalid' };
  return { status: 'known', bids, asks, source: `${venue.toUpperCase()} public order book`, at: readAt, basis: 'real' };
}

export interface CostEvidenceDeps {
  now: () => number;
  /** GET /crossex/fee for the account. */
  listFees: () => Promise<VenueFeeRow[]>;
  fetchBook: (exchange: string, base: string, quote: string) => Promise<VenueBookResult>;
}

export interface LegCostEvidence { fees: FeeEvidence; book: BookEvidence }

/** One fresh read of both legs; nothing is served from a cache or re-stamped. */
export async function readCostEvidence(deps: CostEvidenceDeps, symbols: Record<Side, string>): Promise<Record<Side, LegCostEvidence> & { readAt: number }> {
  const readAt = deps.now();
  const read = async (symbol: string) => {
    const { exchange, base, quote } = parseSymbol(symbol.toUpperCase());
    return deps.fetchBook(exchange, base, quote).then(
      (result) => bookEvidence(result, exchange, readAt),
      (): BookEvidence => ({ status: 'unknown', reason: 'unexpected' }),
    );
  };
  const [rows, shortBook, longBook] = await Promise.all([
    deps.listFees().catch(() => null),
    read(symbols.short),
    read(symbols.long),
  ]);
  const fees = (symbol: string) => feeEvidence(rows, symbol, { source: 'GET /crossex/fee', at: readAt });
  return {
    readAt,
    short: { fees: fees(symbols.short), book: shortBook },
    long: { fees: fees(symbols.long), book: longBook },
  };
}
