import type { FastifyInstance } from 'fastify';
import type { MarginTiers } from '../../../web/src/lib/liquidation';
import { loadMarginTiers } from '../../core/marginTiers';
import { rememberMarks } from '../../core/marks';
import { computeExposure } from '../../core/positions';
import type { AppDeps } from '../app';
import { TTL, type TtlCache } from '../cache';

export async function marginTiersFor(
  cache: TtlCache,
  symbols: readonly string[],
  fresh: boolean,
): Promise<MarginTiers> {
  const wanted = [...new Set(symbols)].filter((s) => s.length > 0).sort();
  if (wanted.length === 0) return {};
  try {
    const { value } = await cache.get(`marginTiers:${wanted.join(',')}`, TTL.static, () => loadMarginTiers(wanted), {
      fresh,
    });
    return value;
  } catch {
    return {};
  }
}

export function positionsRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get('/positions', async (req, reply) => {
      const fresh = (req.query as { fresh?: string }).fresh === '1';
      const { value, stale, observedAt } = await deps.cache.get(
        'positions',
        TTL.live,
        async () => (await deps.getClients().crossEx.listCrossexPositions()).body,
        { fresh },
      );
      const { rows } = rememberMarks(value ?? []);
      const marginTiers = await marginTiersFor(
        deps.cache,
        rows.map((r) => r.symbol ?? ''),
        fresh,
      );
      const quantitySteps: Record<string, { lotSize: string; observedAt: number }> = {};
      if (rows.length) {
        try {
          const rules = await deps.cache.get('rules:all', TTL.static,
            async () => (await deps.getClients().crossEx.listCrossexRuleSymbols()).body);
          if (!rules.stale) for (const row of rows) {
            const matches = rules.value.filter(r => r.symbol === row.symbol && r.businessType === 'FUTURE' && r.state === 'live'
              && Number(r.delistTime ?? '0') === 0);
            if (matches.length === 1 && Number(matches[0].lotSize) > 0) {
              quantitySteps[row.symbol!] = { lotSize: matches[0].lotSize, observedAt: rules.observedAt };
            }
          }
        } catch { /* Missing rule evidence never grants a rounding exemption. */ }
      }
      return reply.ok({ positions: rows, exposure: computeExposure(rows), marginTiers, quantitySteps }, { stale, observedAt });
    });
  };
}
