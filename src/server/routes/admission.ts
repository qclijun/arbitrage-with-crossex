/**
 * The admission switch for new funding-opportunity opens (ticket 19;
 * engine/admission.ts). A route writes the switch and nothing else: it does
 * not stop, pause or wake any deal, and calls no venue. Closing is always
 * allowed; enabling binds to this program and ledger version and is never
 * done on the user's behalf.
 */
import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import type { AppDeps } from '../app';
import { refuse } from '../errorReply';

export function admissionRoutes(deps: AppDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const store = () => {
      if (!deps.engine) throw new CoreError('the engine is not running', 'not-configured');
      return deps.engine.store;
    };

    app.get('/admission', async (_req, reply) => reply.ok(store().admission.read()));

    app.post('/admission', async (req, reply) => {
      const open = (req.body as { open?: unknown } | null)?.open;
      if (typeof open !== 'boolean') throw new CoreError('body must be {"open": true} or {"open": false}', 'validation');
      const admission = store().admission;
      const now = deps.engine!.clock.now();
      if (!open) return reply.ok(admission.disable(now));
      try {
        return reply.ok(admission.enable(now));
      } catch (err) {
        return refuse(reply, { code: 409, category: 'validation', message: (err as Error).message, retryable: false });
      }
    });
  };
}
