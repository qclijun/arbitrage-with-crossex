import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { bucketsFrom } from '../../core/rebalance/plan';

export function accountRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
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
