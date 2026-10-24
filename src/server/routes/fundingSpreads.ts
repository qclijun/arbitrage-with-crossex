import type { FastifyInstance } from 'fastify';
import type { Symbol as RuleSymbol } from 'gate-api';
import { FUNDING_FEEDS, FUNDING_QUOTE, type VenueFundingRate } from '../../core/funding/feeds';
import { buildFundingSpreads, type CrossexListing } from '../../core/funding/spreads';
import { feeRowsForTier } from '../../core/estimate/crossexFeeTiers';
import type { VenueFeeRow } from '../../core/estimate/fees';
import { classifyGateError } from '../../core/errors';
import { parseSymbol } from '../../core/numbers';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { ruleClient } from './opportunities';

/** Funding moves once per settlement at most; a minute keeps the page live without hammering eight venues. */
const FUNDING_TTL = 60_000;

export interface FundingFeedStatus {
  venue: string;
  ok: boolean;
  /** Contracts the feed priced; 0 when it failed. */
  count: number;
  observedAt: number | null;
  /** Served from cache past its TTL (a 429 cooldown) — the rates are older than they look. */
  stale: boolean;
  /** Why the venue has no rates: an error category, `empty` (the feed priced nothing)
   * or `no-feed` (no public funding source is wired for it). Never the upstream message. */
  error: string | null;
}

/**
 * Every live CrossEx perp on the contract each funding feed prices — ALL coins,
 * not just the Boros set. A venue with no feed keeps its listings so its coins
 * read as unquoted rather than vanishing.
 */
function listings(rules: RuleSymbol[]): CrossexListing[] {
  const out: CrossexListing[] = [];
  for (const r of rules) {
    if (r.businessType !== 'FUTURE' || r.state !== 'live' || Number(r.delistTime ?? '0') !== 0) continue;
    const { exchange, base, quote } = parseSymbol(r.symbol);
    const fundingQuote = FUNDING_QUOTE[exchange];
    if (fundingQuote === undefined || fundingQuote === quote) out.push({ venue: exchange, base, symbol: r.symbol });
  }
  return out;
}

class EmptyFeedError extends Error {}

/** A feed that parses to nothing is a broken feed, not a venue with no contracts. */
async function readFeed(venue: string): Promise<VenueFundingRate[]> {
  const rates = await FUNDING_FEEDS[venue]();
  if (!rates.length) throw new EmptyFeedError();
  return rates;
}

/**
 * GET /api/funding-spreads — read-only observation of perp-vs-perp funding
 * spreads across the CrossEx venues. Places nothing; a failed venue feed drops
 * that venue from the rows and is named in `feeds`, and the whole response is
 * marked incomplete.
 */
export function fundingSpreadsRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/funding-spreads', async (req, reply) => {
      const fresh = (req.query as { fresh?: string }).fresh === '1';
      // Every input's clock and staleness folds into the response meta.
      const observed: Array<{ observedAt: number; stale: boolean }> = [];
      const rules = await deps.cache.get(
        'rules:all',
        TTL.static,
        async () => (await ruleClient(deps).listCrossexRuleSymbols()).body,
        { fresh },
      );
      observed.push(rules);
      const listed = listings(rules.value);
      const venues = [...new Set(listed.map((l) => l.venue))].sort();

      const feeds = new Map<string, VenueFundingRate[]>();
      const status: FundingFeedStatus[] = await Promise.all(
        venues.map(async (venue): Promise<FundingFeedStatus> => {
          const down = (error: string): FundingFeedStatus => ({ venue, ok: false, count: 0, observedAt: null, stale: false, error });
          if (!FUNDING_FEEDS[venue]) return down('no-feed');
          try {
            const snap = await deps.cache.get(`funding:${venue}`, FUNDING_TTL, () => readFeed(venue), { fresh });
            feeds.set(venue, snap.value);
            observed.push(snap);
            return { venue, ok: true, count: snap.value.length, observedAt: snap.observedAt, stale: snap.stale, error: null };
          } catch (err) {
            return down(err instanceof EmptyFeedError ? 'empty' : classifyGateError(err).category);
          }
        }),
      );

      // The account's real schedule when keys are set; otherwise VIP 0, flagged.
      let feeRows: VenueFeeRow[];
      let assumedFeeTier: string | null = null;
      try {
        const fees = await deps.cache.get(
          'fees',
          TTL.static,
          async () => (await deps.getClients().crossEx.getCrossexFee()).body,
          { fresh },
        );
        observed.push(fees);
        feeRows = fees.value as VenueFeeRow[];
      } catch {
        feeRows = feeRowsForTier('vip0', venues);
        assumedFeeTier = 'vip0';
      }

      const rows = buildFundingSpreads(listed, feeds, feeRows);
      return reply.ok(
        { rows, feeds: status, assumedFeeTier },
        {
          stale: observed.some((o) => o.stale),
          observedAt: Math.min(...observed.map((o) => o.observedAt)),
          coverageComplete: status.every((s) => s.ok),
        },
      );
    });
  };
}
