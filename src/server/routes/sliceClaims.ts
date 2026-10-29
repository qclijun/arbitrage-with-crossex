import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CoreError } from '../../core/errors';
import { ClaimRefusal, previewClaim } from '../../engine/claim-preview';
import type { ClaimInput, ClaimRow } from '../../engine/claim-types';
import type { AppDeps } from '../app';
import { claimReader } from '../claim-reads';
import { refuse } from '../errorReply';

function inputOf(body: unknown): ClaimInput {
  const b = body as ClaimInput | null;
  if (!b || !['funding-two-leg', 'boros-hedge'].includes(b.kind) || !Array.isArray(b.legs) || b.legs.length !== 2 ||
    !b.legs.every((l) => l && typeof l.contract === 'string' && typeof l.qty === 'string' && ['long', 'short'].includes(l.side)) ||
    !Array.isArray(b.boros) || b.boros.length > 20 || !b.boros.every((p) => p && typeof p.key === 'string' && typeof p.qty === 'string') ||
    (b.root !== undefined && (typeof b.root !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.root)))) {
    throw new CoreError('Select a strategy, two exact legs with decimal quantities, and explicit Boros allocations.', 'validation');
  }
  return { kind: b.kind, legs: b.legs.map(({ contract, side, qty }) => ({ contract, side, qty })),
    boros: b.boros.map(({ key, qty }) => ({ key, qty })), ...(b.root ? { root: b.root.toLowerCase() } : {}) };
}

export function sliceClaimRoutes(deps: AppDeps) {
  return async (app: FastifyInstance): Promise<void> => {
    const engine = () => {
      if (!deps.engine) throw new CoreError('The engine is not running.', 'not-configured');
      return deps.engine;
    };
    const read = deps.readClaimEvidence ?? claimReader(deps.getClients, () => engine().clock.now(), deps.borosFetch);
    const failed = (reply: Parameters<typeof refuse>[0], err: unknown) => refuse(reply, {
      code: err instanceof ClaimRefusal ? 409 : 503, category: err instanceof ClaimRefusal ? 'validation' : 'network',
      label: 'claim-evidence', message: err instanceof ClaimRefusal ? err.message : 'Current evidence unavailable; nothing was claimed. Preview again.', retryable: true,
    });
    app.get('/slices/claim-evidence', async (req, reply) => {
      engine();
      const { root } = req.query as { root?: string };
      try { return reply.ok(await read({ kind: root ? 'boros-hedge' : 'funding-two-leg', root, legs: [], boros: [] })); }
      catch (err) { return failed(reply, err); }
    });
    const view = (row: ClaimRow) =>
      ({ ...row, confirmationPossible: row.status === 'preview' && engine().clock.now() < row.expiresAt });
    app.get('/slices/claims', async (_req, reply) => reply.ok(engine().store.claims.list().map(view)));
    app.get<{ Params: { id: string } }>('/slices/claims/:id', async (req, reply) => {
      const row = engine().store.claims.get(req.params.id);
      if (!row) return refuse(reply, { code: 404, category: 'validation', label: 'claim-not-found', message: 'Claim not found.', retryable: false });
      return reply.ok(view(row));
    });
    app.post<{ Params: { id: string } }>('/slices/claims/:id/discard', async (req, reply) => {
      const e = engine();
      if (!e.store.claims.get(req.params.id)) throw new CoreError('Claim preview not found.', 'validation');
      e.store.claims.discard(req.params.id);
      return reply.ok(view(e.store.claims.get(req.params.id)!));
    });
    app.post('/slices/claims/preview', async (req, reply) => {
      const e = engine();
      const input = inputOf(req.body);
      try {
        const evidence = await read(input);
        const preview = previewClaim(e.store.slices, input, evidence, e.clock.now());
        return reply.ok(e.store.claims.preview(randomUUID(), input, preview, e.clock.now()));
      } catch (err) { return failed(reply, err); }
    });
    app.post<{ Params: { id: string } }>('/slices/claims/:id/confirm', async (req, reply) => {
      const e = engine();
      const row = e.store.claims.get(req.params.id);
      if (!row) throw new CoreError('Claim preview not found.', 'validation');
      if (row.status !== 'preview') return reply.ok(row);
      try {
        const evidence = await read(row.input);
        e.store.atomically(() => {
          // A concurrent discard or confirmation wins before the await.
          if (e.store.claims.get(row.id)?.status !== 'preview') return;
          if (e.clock.now() >= row.expiresAt) throw new ClaimRefusal('Preview expired; preview again.');
          const current = previewClaim(e.store.slices, row.input, evidence, e.clock.now());
          if (current.fingerprint !== row.preview.fingerprint) throw new ClaimRefusal('Positions or ownership changed; review a new preview.');
          e.store.claims.confirm(row.id);
        });
      } catch (err) { return failed(reply, err); }
      e.wake?.();
      return reply.code(202).ok(e.store.claims.get(row.id));
    });
  };
}
