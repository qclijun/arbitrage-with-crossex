/** Public liquidity inputs only. No spread/depth, USD conversion or readiness
 * calculation lives here. Contract: research/02-liquidity-contract.md. */
import { BOROS_NETWORK } from '../../../web/src/lib/borosNetwork';
import { classifyGateError } from '../errors';
import { fetchBorosMarketPage, type FetchLike } from './client';

export const LIQUIDITY_SCOPE = {
  deployment: BOROS_NETWORK.apiBase, chainId: BOROS_NETWORK.chainId,
  isMatured: false, isUiWhitelisted: true, upstreamWhitelistedOnly: true,
  limit: 200, tickSize: 0.0001, includeAmm: false,
} as const;
export type Freshness = 'fresh' | 'stale' | 'unknown';
export interface Evidence<T> {
  value: T | null;
  raw: unknown;
  unit: string;
  source: string;
  marketKey: string | null;
  sourceObservedAt: number | null;
  sourceSyncStatus: unknown;
  collectedAt: number | null;
  freshness: Freshness;
  completeness: 'complete' | 'partial' | 'unknown';
  reason: string[];
}
export interface MarketRow { raw: Record<string, unknown>; collectedAt: number; sourceSyncStatus: unknown }
export interface MarketListing {
  rows: MarketRow[]; pages: number; resumeToken: unknown;
  completeness: 'complete' | 'partial' | 'unknown'; reason: string[];
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
export const marketKey = (id: number): string => `${BOROS_NETWORK.apiBase}:${BOROS_NETWORK.chainId}:${id}`;

/** The market sync clock is NOT a statistic-update clock. Book sync timestamps
 * were verified as Unix seconds; reject wrong magnitude/future values. */
function sourceTime(sync: unknown, collectedAt: number | null): number | null {
  const timestamp = record(sync).timestamp;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 1_000_000_000
    || timestamp >= 10_000_000_000 || collectedAt === null || timestamp * 1000 > collectedAt + 60_000) return null;
  return timestamp * 1000;
}
interface EvidenceOptions<T> {
  value: T | null;
  raw: unknown;
  unit: string;
  source: string;
  marketKey: string | null;
  collectedAt: number | null;
  sourceSyncStatus: unknown;
  ttlMs: number;
  reason?: string[];
  completeness?: Evidence<T>['completeness'];
  clock?: 'book-sync';
}
export function evidence<T>(options: EvidenceOptions<T>): Evidence<T> {
  const { value, raw, unit, source, marketKey, collectedAt, sourceSyncStatus, ttlMs,
    reason = [], completeness = 'complete', clock } = options;
  const sourceObservedAt = clock === 'book-sync' ? sourceTime(sourceSyncStatus, collectedAt) : null;
  const stale = collectedAt !== null && (Date.now() - collectedAt >= ttlMs
    || (sourceObservedAt !== null && Date.now() - sourceObservedAt >= ttlMs));
  return { value, raw: raw ?? null, unit, source, marketKey, sourceObservedAt,
    sourceSyncStatus: sourceSyncStatus ?? null, collectedAt,
    freshness: stale ? 'stale' : sourceObservedAt === null ? 'unknown' : 'fresh',
    completeness: value === null ? 'unknown' : completeness,
    reason: [...new Set([...reason, ...(sourceObservedAt === null ? ['UNKNOWN_SOURCE_TIME'] : []),
      ...(stale ? ['STALE'] : [])])],
  };
}

/** Preserve successful pages on failure. Only an explicit null cursor proves
 * the listing finished; repeated cursors/IDs and non-progress remain partial. */
export async function fetchLiquidityMarkets(fetchImpl: FetchLike): Promise<MarketListing> {
  const rows: MarketRow[] = [];
  const seenIds = new Set<number>();
  const cursors = new Set<string>();
  const reason: string[] = [];
  let resumeToken: string | null = null;
  let pages = 0;
  let lastId = 0;
  for (; pages < 20;) {
    let body: Record<string, unknown>;
    try {
      body = record(await fetchBorosMarketPage(fetchImpl, { resumeToken, isUiWhitelisted: true }));
    } catch (err) {
      if (pages === 0) throw err;
      reason.push(`REQUEST_FAILED:${classifyGateError(err).category}`, 'PAGINATION_INCOMPLETE');
      break;
    }
    pages += 1;
    const collectedAt = Date.now();
    if (!Array.isArray(body.results)) { reason.push('MISSING_RESULTS', 'PAGINATION_INCOMPLETE'); break; }
    if (body.results.length > LIQUIDITY_SCOPE.limit) reason.push('PAGE_SIZE_CONTRACT_VIOLATION');
    let added = 0;
    for (const item of body.results) {
      const raw = record(item);
      if (!positiveId(raw.marketId)) { reason.push('INVALID_MARKET_ID'); continue; }
      if (raw.marketId <= lastId) reason.push('MARKET_ORDER_INVALID');
      lastId = raw.marketId;
      if (seenIds.has(raw.marketId)) { reason.push('DUPLICATE_MARKET_ID'); continue; }
      seenIds.add(raw.marketId);
      rows.push({ raw, collectedAt, sourceSyncStatus: body.syncStatus ?? null });
      added += 1;
    }
    if (body.resumeToken === null) {
      return { rows, pages, resumeToken: null, completeness: reason.length ? 'partial' : 'complete', reason: [...new Set(reason)] };
    }
    if (!text(body.resumeToken)) { reason.push('INVALID_RESUME_TOKEN', 'PAGINATION_INCOMPLETE'); break; }
    resumeToken = body.resumeToken as string;
    if (cursors.has(resumeToken) || added === 0) { reason.push('PAGINATION_NOT_PROGRESSING', 'PAGINATION_INCOMPLETE'); break; }
    cursors.add(resumeToken);
  }
  if (pages === 20) reason.push('PAGE_LIMIT', 'PAGINATION_INCOMPLETE');
  return { rows, pages, resumeToken, completeness: rows.length ? 'partial' : 'unknown', reason: [...new Set(reason)] };
}

export function marketInputs(row: MarketRow, list: MarketListing, ttl: number, failure: string[]) {
  const raw = row.raw;
  const key = marketKey(raw.marketId as number);
  const platform = record(raw.platform);
  const metadata = record(raw.metadata);
  const imData = record(raw.imData);
  const data = record(raw.data);
  const identity = {
    deployment: BOROS_NETWORK.apiBase, chainId: BOROS_NETWORK.chainId, marketId: raw.marketId as number,
    marketAddress: text(raw.address), platformId: text(platform.platformId), venue: text(platform.name),
    symbol: text(metadata.name), underlyingSymbol: text(metadata.underlyingSymbol), fundingRateSymbol: text(metadata.fundingRateSymbol),
    tokenId: positiveId(raw.tokenId) ? raw.tokenId : null,
    maturity: positiveId(imData.maturity) && imData.maturity >= 1_000_000_000 && imData.maturity < 10_000_000_000 ? imData.maturity : null,
    isMatured: typeof raw.isMatured === 'boolean' ? raw.isMatured : null,
    isUiWhitelisted: typeof raw.isUiWhitelisted === 'boolean' ? raw.isUiWhitelisted : null,
  };
  const missing = Object.entries(identity).filter(([, v]) => v === null).map(([k]) => `MISSING_IDENTITY:${k}`);
  const scopeMismatch = identity.isMatured === true || identity.isUiWhitelisted === false ? ['MARKET_FILTER_MISMATCH'] : [];
  const common = [...list.reason, ...failure, ...scopeMismatch];
  const measurement = (field: string, reason: string[]) => {
    const value = typeof data[field] === 'number' && Number.isFinite(data[field]) && data[field] >= 0 ? data[field] as number : null;
    return evidence({ value, raw: data[field], unit: 'YU',
      source: `${BOROS_NETWORK.apiBase}/v1/markets?isMatured=false&isUiWhitelisted=true&limit=200#data.${field}`,
      marketKey: key, collectedAt: row.collectedAt, sourceSyncStatus: row.sourceSyncStatus, ttlMs: ttl,
      reason: [...common, ...reason, ...(value === null ? [`MISSING_OR_INVALID_FIELD:${field}`] : [])], completeness: list.completeness });
  };
  return {
    marketKey: key,
    identity: evidence({ value: identity, raw, unit: 'market-identity', source: `${BOROS_NETWORK.apiBase}/v1/markets#identity`, marketKey: key,
      collectedAt: row.collectedAt, sourceSyncStatus: row.sourceSyncStatus, ttlMs: ttl, reason: [...common, ...missing],
      completeness: missing.length || scopeMismatch.length ? 'partial' : list.completeness }),
    volume24hYu: measurement('volume24h', ['volume-update-time-undocumented', 'trade-route-coverage-undocumented']),
    volumeWindow: 'rolling-24h', oiConvention: 'one-sided',
    notionalOiOneSidedYu: measurement('notionalOI', ['oi-update-time-undocumented']),
  };
}

export interface BookLevel { aggregateIndex: number; apr: number; sizeRaw: string; sizeYu: string }
export function formatYuRaw(raw: string): string {
  const n = BigInt(raw);
  const fraction = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${n / 10n ** 18n}${fraction ? `.${fraction}` : ''}`;
}
export function bookInputs(body: unknown, id: number, collectedAt: number | null, ttl: number, failure: string[]) {
  const response = record(body);
  const sync = response.syncStatus;
  const side = (name: 'long' | 'short') => {
    const raw = record(response[name]);
    const reason = [...failure];
    const source = `${BOROS_NETWORK.apiBase}/v1/markets/order-book?marketId=${id}&tickSize=0.0001&includeAmm=false#${name}`;
    let levels: BookLevel[] | null = null;
    let discardedLevels = 0;
    const returnedLevels = Array.isArray(raw.ia) ? raw.ia.length : null;
    if (!Array.isArray(raw.ia) || !Array.isArray(raw.sz) || raw.ia.length !== raw.sz.length) {
      reason.push('MISSING_OR_MISMATCHED_SIDE');
    } else {
      levels = [];
      const seen = new Set<number>();
      for (let i = 0; i < raw.ia.length; i += 1) {
        const index = raw.ia[i];
        const size = raw.sz[i];
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || typeof size !== 'string'
          || !/^\d+$/.test(size) || BigInt(size) <= 0n || seen.has(index)) {
          discardedLevels += 1; continue;
        }
        seen.add(index);
        levels.push({ aggregateIndex: index, apr: index * LIQUIDITY_SCOPE.tickSize, sizeRaw: size, sizeYu: formatYuRaw(size) });
      }
      levels.sort((a, b) => name === 'long' ? b.aggregateIndex - a.aggregateIndex : a.aggregateIndex - b.aggregateIndex);
      if (discardedLevels) reason.push('INVALID_OR_DUPLICATE_LEVELS');
      if (levels.length > 50) { levels = levels.slice(0, 50); reason.push('CLIENT_TRUNCATED', 'UPSTREAM_CAP_CONTRACT_VIOLATION'); }
      if (raw.ia.length >= 50) reason.push('SERVER_BEST_50_LIMIT');
      // Even <50 nonempty levels do not prove full-book coverage.
      if (raw.ia.length > 0) reason.push('FULL_BOOK_COVERAGE_UNKNOWN');
    }
    const result = evidence({ value: levels, raw: response[name], unit: '18-decimal-YU', source, marketKey: marketKey(id),
      collectedAt, sourceSyncStatus: sync, ttlMs: ttl, reason,
      completeness: levels !== null && returnedLevels === 0 ? 'complete' : 'partial', clock: 'book-sync' });
    return { ...result, returnedLevels, validLevels: levels?.length ?? null, discardedLevels,
      serverLevelCap: 50, potentiallyTruncated: returnedLevels !== null && returnedLevels >= 50 };
  };
  return { tickSize: LIQUIDITY_SCOPE.tickSize, includeAmm: false, coverage: 'returned-levels', bids: side('long'), asks: side('short') };
}
