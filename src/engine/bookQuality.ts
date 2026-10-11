/**
 * Book-quality seam — what makes a local top-of-book usable for automatic
 * quoting. This lives in ONE place because both consumers of it must agree:
 * the `'best'` quote source (this ticket) and the book-outage pause (ticket
 * 04), which are otherwise two definitions of "the book is available".
 *
 * Neither existing venue helper expresses this predicate:
 *   - `venueGate.touch` ACCEPTS a degenerate book and silently degrades it to a
 *     bare same-side touch (one-sided, crossed, or a spread whose one-gap
 *     extrusion goes non-positive).
 *   - `venueGate.refPrice` checks only `Number.isFinite` and happily returns a
 *     mid from a crossed book (`ask < bid`).
 * So a caller reading either one has no way to tell a real two-sided book from
 * a broken one. `isQuotableBook` is that missing test.
 */
import { formatRestPrice } from '../core/numbers';
import type { Side } from './types';

/** The top of a book, already lifted from a venue's raw levels. `null` means
 * the level was absent, unparseable, or non-positive. */
export interface TopOfBook {
  bid: number | null;
  ask: number | null;
}

/**
 * A book is QUOTABLE only when BOTH sides are present, both are positive finite
 * numbers, AND `ask > bid`. Anything else — a missing side, a non-positive or
 * unparseable level, a crossed book — is NOT a valid quote source, and the
 * caller must neither place a new maker nor reprice.
 *
 * Deliberately STRICTER than both existing helpers: a one-sided book is a legal
 * object here (`{bids:[…], asks:[]}`) but must never be treated as quotable, and
 * the middle-price helper must never return a price for a crossed book.
 */
export function isQuotableBook(book: TopOfBook | null | undefined): book is { bid: number; ask: number } {
  if (!book) return false;
  const { bid, ask } = book;
  return (
    typeof bid === 'number' &&
    Number.isFinite(bid) &&
    bid > 0 &&
    typeof ask === 'number' &&
    Number.isFinite(ask) &&
    ask > 0 &&
    ask > bid
  );
}

/** Lift a raw best bid/ask pair into a `TopOfBook`, coercing anything that is
 * not a positive finite number to `null` (never `NaN`/`0`, which compare
 * misleadingly). */
export function topOf(bidRaw: unknown, askRaw: unknown): TopOfBook {
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return { bid: num(bidRaw), ask: num(askRaw) };
}

/**
 * The BARE same-side best price for a `'best'` quote — best bid for BUY, best
 * ask for SELL, with NO spread offset (the one-gap-behind offset is the OLD
 * `'touch'` semantics and must not change). Formatted through
 * `formatRestPrice`, so the directional tick snap AND Hyperliquid's
 * five-significant-figure cap both apply in the SAFE direction (BUY down, SELL
 * up). Returns `null` when the book is not quotable or the formatted price is
 * not positive — the caller then places NOTHING rather than guessing.
 */
export function bestQuotePrice(
  book: TopOfBook | null | undefined,
  side: Side,
  contract: string,
  tick: string,
): string | null {
  if (!isQuotableBook(book)) return null;
  const px = side === 'BUY' ? book.bid : book.ask;
  const formatted = formatRestPrice(px, side, contract, tick);
  return Number(formatted) > 0 ? formatted : null;
}
