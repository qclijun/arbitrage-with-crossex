/** Demand-driven public snapshots. Scope keys cannot collide with normalized
 * strategy/quote/trade caches, whose filters and evidence contracts differ. */
import type { FastifyInstance } from 'fastify';
import { BOROS_NETWORK } from '../../../web/src/lib/borosNetwork';
import { fetchBorosCollateralAssets, fetchBorosOrderBookResponse, resolveBorosFetch } from '../../core/boros/client';
import { bookInputs, evidence, fetchLiquidityMarkets, LIQUIDITY_SCOPE, marketInputs, record, type MarketListing } from '../../core/boros/liquidity';
import { calculateLiquidityMetrics } from '../../core/boros/liquidity-metrics';
import { classifyGateError, CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { TTL } from '../cache';

export function borosLiquidityRoutes(deps: AppDeps) {
  const fetchImpl = resolveBorosFetch(deps.borosFetch);
  const scopeKey = `boros:liquidity:${BOROS_NETWORK.apiBase}:${BOROS_NETWORK.chainId}`;
  async function cached<T>(key: string, ttl: number, fetch: () => Promise<T>) {
    try {
      const snapshot = await deps.cache.get(key, ttl, fetch);
      return { value: snapshot.value as T | null, collectedAt: snapshot.observedAt,
        reason: snapshot.stale ? ['STALE', 'REQUEST_FAILED:rate-limited'] : [] };
    } catch (err) {
      const previous = deps.cache.peek<T>(key);
      return { value: previous?.value ?? null, collectedAt: previous?.observedAt ?? null,
        reason: [`REQUEST_FAILED:${classifyGateError(err).category}`, ...(previous ? ['STALE', 'RETAINED_PREVIOUS_SNAPSHOT'] : [])] };
    }
  }
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/boros/liquidity', async (req, reply) => {
      // No force-refresh or alternate scope: use the existing TTL/cooldown.
      if (Object.keys(req.query as object).length) throw new CoreError('Boros liquidity has a fixed public query scope', 'validation');
      const listing = await cached(`${scopeKey}:markets:isMatured=false:isUiWhitelisted=true:limit=200`, TTL.boros,
        () => fetchLiquidityMarkets(fetchImpl));
      const list: MarketListing = listing.value ?? { rows: [], pages: 0, resumeToken: null, completeness: 'unknown', reason: [] };
      const assets = list.rows.length ? await cached(`${scopeKey}:assets:isCollateral=true`, TTL.boros,
        () => fetchBorosCollateralAssets(fetchImpl)) : { value: null, collectedAt: null, reason: ['NOT_REQUESTED_WITHOUT_MARKETS'] };
      const assetsBody = record(assets.value);
      const assetRows = Array.isArray(assetsBody.results) ? assetsBody.results.map(record) : [];
      const markets = [];
      // Sequential public books bound concurrent pressure without new polling.
      for (const row of list.rows) {
        const inputs = marketInputs(row, list, TTL.boros, listing.reason);
        const id = inputs.identity.value!.marketId;
        const tokenId = inputs.identity.value!.tokenId;
        const matches = assetRows.filter(asset => tokenId !== null && asset.tokenId === tokenId);
        const asset = matches.length === 1 ? matches[0] : null;
        const collateral = asset ? {
          tokenId, assetId: typeof asset.id === 'string' ? asset.id : null,
          symbol: typeof asset.symbol === 'string' ? asset.symbol : null,
          decimals: typeof asset.decimals === 'number' && Number.isInteger(asset.decimals) && asset.decimals >= 0 ? asset.decimals : null,
          // Official asset id is not an ERC20 address. No cross-market guesses.
          address: typeof asset.address === 'string' ? asset.address : null,
        } : null;
        const collateralReason = [...assets.reason, ...(matches.length !== 1 ? ['COLLATERAL_MISSING_OR_AMBIGUOUS'] : []),
          ...(collateral?.address ? [] : ['COLLATERAL_ADDRESS_UNKNOWN']),
          ...(collateral && (!collateral.assetId || !collateral.symbol || collateral.decimals === null) ? ['COLLATERAL_FIELDS_MISSING'] : [])];
        const book = await cached(`${scopeKey}:book:${id}:tickSize=0.0001:includeAmm=false`, TTL.borosBook,
          () => fetchBorosOrderBookResponse(fetchImpl, id, false));
        const snapshot = { ...inputs,
          collateral: evidence({ value: collateral, raw: asset, unit: 'collateral-identity',
            source: `${BOROS_NETWORK.apiBase}/v1/assets?isCollateral=true#tokenId=${tokenId}`, marketKey: inputs.marketKey,
            collectedAt: assets.collectedAt, sourceSyncStatus: null, ttlMs: TTL.boros, reason: collateralReason,
            completeness: collateralReason.length ? 'partial' : 'complete' }),
          book: bookInputs(book.value, id, book.collectedAt, TTL.borosBook, book.reason),
        };
        markets.push({ ...snapshot, metrics: calculateLiquidityMetrics(snapshot.book, snapshot.collateral) });
      }
      const coverage = evidence({ value: { returnedMarkets: list.rows.length, pages: list.pages, resumeToken: list.resumeToken }, raw: null,
        unit: 'market-list-coverage', source: `${BOROS_NETWORK.apiBase}/v1/markets?isMatured=false&isUiWhitelisted=true&limit=200`, marketKey: null,
        collectedAt: listing.collectedAt, sourceSyncStatus: null, ttlMs: TTL.boros,
        reason: [...list.reason, ...listing.reason], completeness: list.completeness });
      return reply.ok({ scope: LIQUIDITY_SCOPE, coverage, markets });
    });
  };
}
