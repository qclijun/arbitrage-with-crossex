/**
 * Per-venue PUBLIC funding-rate feeds for the perp-vs-perp funding view. CrossEx
 * exposes no funding data, so — like the order books in `estimate/books.ts` —
 * each venue's own bulk endpoint is read directly: one request (two for the
 * Binance-style venues) returns the current rate of every contract it lists.
 * Parsers are pure and drop rows they can't read; a venue whose feed fails is
 * reported by the caller, never guessed.
 */
import axios from 'axios';
import { bookRequestOptions } from '../estimate/books';

export interface VenueFundingRate {
  /** The venue-native base exactly as CrossEx lists it (kPEPE, 1000PEPE, SHIB1000). */
  base: string;
  /** Current-period rate, a fraction per funding interval. */
  rate: number;
  intervalHours: number;
  /** Mark price of one venue contract unit, when the feed carries it. */
  markPrice: number | null;
  /** Unix ms of the next settlement, when the feed says. */
  nextFundingTime: number | null;
}

/** Bulk feeds are much larger than a book; give them more than the 2.5 s book budget. */
const FEED_TIMEOUT_MS = 10_000;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const rows = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null) : [];

function push(out: VenueFundingRate[], base: string, rate: number | null, intervalHours: number | null, markPrice: unknown, next: unknown): void {
  if (!base || rate === null || intervalHours === null || intervalHours <= 0) return;
  out.push({ base, rate, intervalHours, markPrice: positive(markPrice), nextFundingTime: positive(next) });
}

/** Binance / Aster: premiumIndex (rate, mark) + fundingInfo (only symbols off the 8 h default on Binance). */
export function parseBinanceStyle(premiumIndex: unknown, fundingInfo: unknown): VenueFundingRate[] {
  const hours = new Map<string, number>();
  for (const r of rows(fundingInfo)) {
    const h = positive(r.fundingIntervalHours);
    if (typeof r.symbol === 'string' && h !== null) hours.set(r.symbol, h);
  }
  const out: VenueFundingRate[] = [];
  for (const r of rows(premiumIndex)) {
    if (typeof r.symbol !== 'string' || !r.symbol.endsWith('USDT')) continue;
    push(out, r.symbol.slice(0, -4), num(r.lastFundingRate), hours.get(r.symbol) ?? 8, r.markPrice, r.nextFundingTime);
  }
  return out;
}

/** OKX `funding-rate?instId=ANY`: the interval is the gap between the current and previous settlement. */
export function parseOkx(json: unknown): VenueFundingRate[] {
  const out: VenueFundingRate[] = [];
  for (const r of rows((json as { data?: unknown } | null)?.data)) {
    const m = typeof r.instId === 'string' ? /^(.+)-USDT-SWAP$/.exec(r.instId) : null;
    if (!m) continue;
    const current = num(r.fundingTime);
    const prev = num(r.prevFundingTime);
    const hours = current !== null && prev !== null && current > prev ? (current - prev) / 3_600_000 : null;
    push(out, m[1], num(r.fundingRate), hours, null, r.fundingTime);
  }
  return out;
}

/** Bybit linear tickers carry the rate, the interval and the mark in one list. */
export function parseBybit(json: unknown): VenueFundingRate[] {
  const out: VenueFundingRate[] = [];
  for (const r of rows((json as { result?: { list?: unknown } } | null)?.result?.list)) {
    if (typeof r.symbol !== 'string' || !r.symbol.endsWith('USDT')) continue;
    push(out, r.symbol.slice(0, -4), num(r.fundingRate), positive(r.fundingIntervalHour), r.markPrice, r.nextFundingTime);
  }
  return out;
}

/** Gate USDT futures contracts: interval in seconds, next settlement in seconds. */
export function parseGate(json: unknown): VenueFundingRate[] {
  const out: VenueFundingRate[] = [];
  for (const r of rows(json)) {
    if (typeof r.name !== 'string' || !r.name.endsWith('_USDT') || r.in_delisting === true) continue;
    const interval = positive(r.funding_interval);
    const next = positive(r.funding_next_apply);
    push(out, r.name.slice(0, -5), num(r.funding_rate), interval === null ? null : interval / 3600, r.mark_price, next === null ? null : next * 1000);
  }
  return out;
}

/** Hyperliquid metaAndAssetCtxs: `[meta, ctxs]` index-aligned; funding is hourly. */
export function parseHyperliquid(json: unknown): VenueFundingRate[] {
  if (!Array.isArray(json) || json.length < 2) return [];
  const universe = rows((json[0] as { universe?: unknown } | null)?.universe);
  const ctxs = rows(json[1]);
  const out: VenueFundingRate[] = [];
  universe.forEach((u, i) => {
    const ctx = ctxs[i];
    if (!ctx || typeof u.name !== 'string' || u.isDelisted === true) return;
    push(out, u.name, num(ctx.funding), 1, ctx.markPx, null);
  });
  return out;
}

/** Kraken perpetuals: `relativeFundingRate` is the hourly fraction; Kraken spells BTC as XBT. */
export function parseKraken(json: unknown): VenueFundingRate[] {
  const out: VenueFundingRate[] = [];
  for (const r of rows((json as { tickers?: unknown } | null)?.tickers)) {
    const m = typeof r.symbol === 'string' && r.tag === 'perpetual' ? /^PF_(.+)USD$/.exec(r.symbol) : null;
    if (!m || r.suspended === true) continue;
    push(out, m[1] === 'XBT' ? 'BTC' : m[1], num(r.relativeFundingRate), 1, r.markPrice, null);
  }
  return out;
}

/** Lighter's funding-rates lists several exchanges; its own rows are normalised to an
 * 8 h rate (its Hyperliquid rows read exactly 8× Hyperliquid's hourly rate). */
export function parseLighter(json: unknown): VenueFundingRate[] {
  const out: VenueFundingRate[] = [];
  for (const r of rows((json as { funding_rates?: unknown } | null)?.funding_rates)) {
    if (r.exchange !== 'lighter' || typeof r.symbol !== 'string') continue;
    push(out, r.symbol, num(r.rate), 8, null, null);
  }
  return out;
}

async function getJson(url: string): Promise<unknown> {
  return (await axios.get(url, { ...bookRequestOptions(), timeout: FEED_TIMEOUT_MS })).data;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  return (await axios.post(url, body, { ...bookRequestOptions(), timeout: FEED_TIMEOUT_MS })).data;
}

async function binanceStyle(host: string): Promise<VenueFundingRate[]> {
  const [premium, info] = await Promise.all([getJson(`${host}/fapi/v1/premiumIndex`), getJson(`${host}/fapi/v1/fundingInfo`)]);
  return parseBinanceStyle(premium, info);
}

/** Venue → bulk funding read. Deribit (continuous funding, per-instrument reads) is not covered. */
export const FUNDING_FEEDS: Record<string, () => Promise<VenueFundingRate[]>> = {
  BINANCE: () => binanceStyle('https://fapi.binance.com'),
  ASTER: () => binanceStyle('https://fapi.asterdex.com'),
  OKX: async () => parseOkx(await getJson('https://www.okx.com/api/v5/public/funding-rate?instId=ANY')),
  BYBIT: async () => parseBybit(await getJson('https://api.bybit.com/v5/market/tickers?category=linear')),
  GATE: async () => parseGate(await getJson('https://api.gateio.ws/api/v4/futures/usdt/contracts')),
  HYPERLIQUID: async () => parseHyperliquid(await postJson('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' })),
  KRAKEN: async () => parseKraken(await getJson('https://futures.kraken.com/derivatives/api/v3/tickers')),
  LIGHTER: async () => parseLighter(await getJson('https://mainnet.zklighter.elliot.ai/api/v1/funding-rates')),
};

/** The one quote whose contract each feed above prices (USDC twins on the CEXes are separate books). */
export const FUNDING_QUOTE: Record<string, string> = {
  BINANCE: 'USDT', ASTER: 'USDT', OKX: 'USDT', BYBIT: 'USDT', GATE: 'USDT',
  HYPERLIQUID: 'USDC', LIGHTER: 'USDC', KRAKEN: 'USD',
};
