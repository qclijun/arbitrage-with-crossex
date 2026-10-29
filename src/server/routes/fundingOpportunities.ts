/**
 * GET /api/funding/opportunities (ticket 18) — the read-only ranking of every
 * directed perp-vs-perp funding pair. It reads the published history cache
 * and the in-memory market only, so a request never reaches a venue; it
 * writes nothing and opens nothing (new opens go through ticket 12's preview
 * and admission, closed by default).
 */
import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { buildFundingBoard, isHistoryDays, type BoardQuery } from '../funding/board';

const MAX_LIMIT = 200;

function integer(raw: string | undefined, fallback: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new CoreError(`${name} must be an integer from ${min} to ${max}`, 'validation');
  return n;
}

function days(raw: string | undefined, fallback: number, name: string) {
  const n = integer(raw, fallback, name, 1);
  if (!isHistoryDays(n)) throw new CoreError(`${name} must be one of 7, 30, 90, 180, 365`, 'validation');
  return n;
}

const list = (raw: string | undefined): string[] | undefined => {
  const items = raw?.split(',').map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
};

function parseQuery(q: Record<string, string | undefined>): BoardQuery {
  if (q.positive !== undefined && q.positive !== '0' && q.positive !== '1') throw new CoreError('positive must be 0 or 1', 'validation');
  if (q.rankingId !== undefined && !/^[0-9a-f]{64}$/.test(q.rankingId)) throw new CoreError('rankingId is not a ranking fingerprint', 'validation');
  return {
    days: days(q.days, 30, 'days'),
    compareDays: days(q.compare, 7, 'compare'),
    underlyings: list(q.underlying),
    venues: list(q.venue),
    positiveOnly: q.positive === '1',
    offset: integer(q.offset, 0, 'offset', 0),
    limit: integer(q.limit, 50, 'limit', 1, MAX_LIMIT),
    rankingId: q.rankingId,
  };
}

export function fundingOpportunitiesRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/funding/opportunities', async (req, reply) => {
      const query = parseQuery(req.query as Record<string, string | undefined>);
      const board = deps.opportunities;
      if (!board) throw new CoreError('funding opportunities are not wired in this mode', 'not-configured');
      const now = deps.engine?.clock.now() ?? Date.now();
      return reply.ok(buildFundingBoard({
        query, history: board.history, market: board.market.view(), admission: deps.engine?.store.admission.read() ?? null, now,
      }));
    });
  };
}
