import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { bucketsFrom } from '../../core/rebalance/plan';
import { computeExposure } from '../../core/positions';
import { gateNumber, liquidationLines } from '../../../web/src/lib/liquidation';
import type { CrossexAccount, CrossexPosition } from '../../../web/src/api/types';
import { marginTiersFor } from './positions';

export function accountRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/account/liquidation', async (req, reply) => {
      const fresh = (req.query as { fresh?: string }).fresh === '1';
      const [account, positions] = await Promise.all([
        deps.cache.get('account', TTL.live, async () => (await deps.getClients().crossEx.getCrossexAccount()).body, { fresh }),
        deps.cache.get('positions', TTL.live, async () => (await deps.getClients().crossEx.listCrossexPositions()).body, { fresh }),
      ]);
      const rows = positions.value ?? [];
      const exposure = computeExposure(rows);
      const tiers = await marginTiersFor(deps.cache, rows.map((p) => p.symbol ?? ''), fresh);
      // Reject omitted or unpriced exposure instead of reporting another coin's
      // farther line as the account's nearest liquidation distance.
      const complete = rows.every((p) => gateNumber(p.positionQty) !== null)
        && exposure.every((g) => g.base && g.legs.every((l) => Number.isFinite(l.value) && l.value > 0));
      const view = complete ? liquidationLines(account.value as unknown as CrossexAccount,
        { positions: rows as unknown as CrossexPosition[], exposure }, {}, tiers) : null;
      const distance = view && view.unknown.length === 0 && view.lines.length > 0
        ? Math.min(...view.lines.map((line) => Math.abs(line.move))) : null;
      return reply.ok({ distance, view,
        assumptions: 'One coin moves at a time; other coins fixed; no future funding, interest or venue price gaps; missing tiers use current margin rate',
      }, { stale: account.stale || positions.stale });
    });
    app.get('/account/interest', async (req, reply) => {
      const fresh = (req.query as { fresh?: string }).fresh === '1';
      const [account, rates] = await Promise.all([
        deps.cache.get('account', TTL.live, async () => (await deps.getClients().crossEx.getCrossexAccount()).body, { fresh }),
        deps.cache.get('interest:rate', TTL.static,
          async () => (await deps.getClients().crossEx.getCrossexInterestRate()).body, { fresh }).catch(() => null),
      ]);
      // Interest unavailability must not discard independently valid account data.
      const buckets = rates && !rates.stale ? bucketsFrom(account.value, rates.value, {}) : null;
      return reply.ok({ account: account.value, buckets }, { stale: account.stale });
    });
    app.get('/account', async (req, reply) => {
      const fresh = (req.query as { fresh?: string }).fresh === '1';
      const { value, stale } = await deps.cache.get(
        'account',
        TTL.live,
        async () => (await deps.getClients().crossEx.getCrossexAccount()).body,
        { fresh },
      );
      return reply.ok(value, { stale });
    });
  };
}
