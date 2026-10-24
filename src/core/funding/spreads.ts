/**
 * Perp-vs-perp funding spreads: for every coin CrossEx lists on two or more
 * venues, short the perp whose funding pays most and long the one that pays
 * least. No Boros leg — the spread is FLOATING, read off the venues' current
 * rates, so a row is something to watch, not a locked return. Pure: the route
 * does the IO.
 */
import { resolveFeeRates, type VenueFeeRow } from '../estimate/fees';
import type { VenueFundingRate } from './feeds';

const HOURS_IN_YEAR = 365 * 24;
/** Two legs whose per-coin prices differ by more than this are not the same asset. */
const PRICE_TOLERANCE = 0.05;

export interface CrossexListing {
  venue: string;
  base: string;
  symbol: string;
}

export interface FundingQuote {
  venue: string;
  symbol: string;
  rate: number;
  intervalHours: number;
  apr: number;
  /** Mark price per ONE coin (contract multiplier divided out); null = feed has no price. */
  unitPrice: number | null;
  nextFundingTime: number | null;
}

export interface FundingSpreadRow {
  underlying: string;
  /** Receives funding: the venue with the highest rate. */
  short: FundingQuote;
  /** Pays funding: the venue with the lowest rate. */
  long: FundingQuote;
  spreadApr: number;
  /** Every venue quoting the coin, highest APR first. */
  venues: FundingQuote[];
  /** Taker open + close on both legs, as a fraction of one leg's notional. */
  roundTripFeeRate: number | null;
  /** Days of the current spread needed to pay back the round trip. */
  paybackDays: number | null;
  /** Both legs priced and the prices disagree — likely two different assets. */
  priceMismatch: boolean;
  /** A leg has no price in its feed, so the same-asset check could not run. */
  priceUnchecked: boolean;
  /** Venues CrossEx lists the coin on whose rate is unknown (feed failed, not
   * covered, or the coin missing from it) — the best pair may be among them. */
  unquotedVenues: string[];
}

/** `1000PEPE`, `1MBABYDOGE`, `kPEPE`, `SHIB1000` → the coin and how many of it one contract unit is. */
export function underlyingOf(base: string): { underlying: string; multiplier: number } {
  const mega = /^1M([A-Z].*)$/.exec(base);
  if (mega) return { underlying: mega[1], multiplier: 1_000_000 };
  const prefix = /^(1000000|100000|10000|1000)([A-Z].*)$/.exec(base);
  if (prefix) return { underlying: prefix[2], multiplier: Number(prefix[1]) };
  const kilo = /^k([A-Z].*)$/.exec(base);
  if (kilo) return { underlying: kilo[1], multiplier: 1000 };
  const suffix = /^([A-Z].*?)(1000000|100000|10000|1000)$/.exec(base);
  if (suffix) return { underlying: suffix[1], multiplier: Number(suffix[2]) };
  return { underlying: base.toUpperCase(), multiplier: 1 };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const apart = (a: number, b: number): boolean => Math.max(a, b) / Math.min(a, b) - 1 > PRICE_TOLERANCE;

/**
 * With three or more priced venues the median names the asset; a venue far off
 * it is a different token under the same ticker and is dropped. Unpriced venues
 * stay — there is no evidence either way.
 */
function dropPriceOutliers(quotes: FundingQuote[]): FundingQuote[] {
  const prices = quotes.flatMap((q) => (q.unitPrice === null ? [] : [q.unitPrice]));
  if (prices.length < 3) return quotes;
  const mid = median(prices);
  return quotes.filter((q) => q.unitPrice === null || !apart(q.unitPrice, mid));
}

function roundTrip(feeRows: VenueFeeRow[] | null, a: string, b: string): number | null {
  if (!feeRows) return null;
  const ra = resolveFeeRates(feeRows, a);
  const rb = resolveFeeRates(feeRows, b);
  return ra && rb ? 2 * (ra.takerRate + rb.takerRate) : null;
}

export function buildFundingSpreads(
  listings: CrossexListing[],
  feeds: ReadonlyMap<string, VenueFundingRate[]>,
  feeRows: VenueFeeRow[] | null,
): FundingSpreadRow[] {
  const rateByVenueBase = new Map<string, VenueFundingRate>();
  for (const [venue, rates] of feeds) for (const r of rates) rateByVenueBase.set(`${venue}:${r.base}`, r);

  const byUnderlying = new Map<string, FundingQuote[]>();
  const listedVenues = new Map<string, Set<string>>();
  for (const l of listings) {
    const { underlying, multiplier } = underlyingOf(l.base);
    listedVenues.set(underlying, (listedVenues.get(underlying) ?? new Set<string>()).add(l.venue));
    const r = rateByVenueBase.get(`${l.venue}:${l.base}`);
    if (!r) continue;
    const quote: FundingQuote = {
      venue: l.venue,
      symbol: l.symbol,
      rate: r.rate,
      intervalHours: r.intervalHours,
      apr: (r.rate * HOURS_IN_YEAR) / r.intervalHours,
      unitPrice: r.markPrice === null ? null : r.markPrice / multiplier,
      nextFundingTime: r.nextFundingTime,
    };
    // One contract per venue per coin: a venue listing both 1000X and X keeps the first.
    const list = byUnderlying.get(underlying) ?? [];
    if (!list.some((q) => q.venue === l.venue)) list.push(quote);
    byUnderlying.set(underlying, list);
  }

  const out: FundingSpreadRow[] = [];
  for (const [underlying, all] of byUnderlying) {
    const venues = dropPriceOutliers(all).sort((a, b) => b.apr - a.apr);
    if (venues.length < 2) continue;
    const quoted = new Set(all.map((q) => q.venue));
    const short = venues[0];
    const long = venues[venues.length - 1];
    const spreadApr = short.apr - long.apr;
    const fee = roundTrip(feeRows, short.symbol, long.symbol);
    const priced = short.unitPrice !== null && long.unitPrice !== null;
    out.push({
      underlying,
      short,
      long,
      spreadApr,
      venues,
      roundTripFeeRate: fee,
      paybackDays: fee !== null && spreadApr > 0 ? fee / (spreadApr / 365) : null,
      priceMismatch: priced && apart(short.unitPrice as number, long.unitPrice as number),
      priceUnchecked: !priced,
      unquotedVenues: [...(listedVenues.get(underlying) ?? [])].filter((v) => !quoted.has(v)).sort(),
    });
  }
  return out.sort((a, b) => b.spreadApr - a.spreadApr);
}
