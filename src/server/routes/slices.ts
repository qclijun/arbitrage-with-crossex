/**
 * Strategy slices (ticket 15; engine/slices.ts). GET reads every slice and
 * reconciles each tracked contract against a FRESH position read — an
 * unreadable position is UNKNOWN, never zero. POST /slices/recover is the
 * user's explicit reconciliation of an unexplained change: it is accepted
 * only for the position the server reads now, writes the ledger and nothing
 * else — no order, no wake.
 */
import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import { fx } from '../../engine/fx';
import { reconcileContract } from '../../engine/slice-reconcile';
import { SliceRefusal } from '../../engine/slices';
import type { AppDeps } from '../app';
import { recordUnreconciled } from '../dealGates';
import { refuse } from '../errorReply';
import { readSignedPositions } from '../livePositions';

async function readPositions(deps: AppDeps): Promise<Map<string, string> | null> {
  try {
    return await readSignedPositions(deps.getClients());
  } catch {
    return null;
  }
}

export function slicesRoutes(deps: AppDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const store = () => {
      if (!deps.engine) throw new CoreError('the engine is not running', 'not-configured');
      return deps.engine.store;
    };

    app.get('/slices', async (_req, reply) => {
      const s = store();
      const positions = await readPositions(deps);
      const actualOf = (contract: string): string | null => (positions ? (positions.get(contract) ?? '0') : null);
      const now = deps.engine!.clock.now();
      const contracts = s.slices.trackedContracts().map((contract) => {
        const rec = reconcileContract(s.slices.contractState(contract), actualOf(contract));
        if (rec.unknown && rec.actual !== null) recordUnreconciled(s, contract, rec, now);
        return { contract, ...rec };
      });
      return reply.ok({
        slices: s.slices.list().map((slice) => ({ ...slice, reducible: s.slices.reducible(slice.id) })),
        contracts,
      }, { observedAt: Date.now() });
    });

    app.post('/slices/recover', async (req, reply) => {
      const body = (req.body ?? {}) as {
        contract?: unknown; observedActual?: unknown; evidence?: unknown;
        adjustments?: Array<{ sliceId?: unknown; leg?: unknown; delta?: unknown }>;
      };
      const adjustments = Array.isArray(body.adjustments) ? body.adjustments : null;
      if (typeof body.contract !== 'string' || typeof body.observedActual !== 'string' || typeof body.evidence !== 'string' ||
        !adjustments || !adjustments.every((a) => typeof a.sliceId === 'string' && typeof a.leg === 'string' && typeof a.delta === 'string')) {
        throw new CoreError('body must be {contract, observedActual, evidence, adjustments: [{sliceId, leg, delta}]} with decimal strings', 'validation');
      }
      const positions = await readPositions(deps);
      if (!positions) {
        return refuse(reply, { code: 503, category: 'network', label: 'position-unreadable', message: 'could not read the position to reconcile against; nothing was changed', retryable: true });
      }
      const contract = body.contract.toUpperCase();
      const actual = positions.get(contract) ?? '0';
      let observed: bigint;
      try {
        observed = fx(body.observedActual);
      } catch {
        throw new CoreError('observedActual must be a decimal string', 'validation');
      }
      if (observed !== fx(actual)) {
        return refuse(reply, { code: 409, category: 'validation', label: 'position-changed', message: `${contract} is ${actual} now, not ${body.observedActual}; review it again. Nothing was changed.`, retryable: true });
      }
      try {
        store().slices.recover({
          contract, observedActual: actual, evidence: body.evidence, now: deps.engine!.clock.now(),
          adjustments: adjustments.map((a) => ({ sliceId: a.sliceId as string, leg: a.leg as string, delta: a.delta as string })),
        });
      } catch (err) {
        if (!(err instanceof SliceRefusal)) throw err;
        return refuse(reply, { code: err.status, category: 'validation', label: `slice-${err.code}`, message: err.message, retryable: false });
      }
      return reply.ok(reconcileContract(store().slices.contractState(contract), actual));
    });
  };
}
