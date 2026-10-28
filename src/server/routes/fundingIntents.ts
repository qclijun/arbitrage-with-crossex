/**
 * Funding-opportunity preview, acceptance and receipt (ticket 12).
 *
 *   POST /api/funding/preview      fresh read-only evidence → content to confirm
 *   POST /api/funding/intents      accept a confirmed, still-valid preview
 *   GET  /api/funding/intents/:id  the durable receipt, finished deals included
 *
 * Nothing here touches a venue but to read. Acceptance re-reads every piece
 * of evidence, must find the same content the user confirmed, and lands
 * within 10 s of both the preview's and its own evidence round; otherwise it
 * answers with a new preview to confirm. It writes the intent, slice and deal
 * in one admission transaction and wakes the engine, which alone sets
 * leverage and places orders.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CoreError } from '../../core/errors';
import type { Store } from '../../engine/db';
import { reconcileContract } from '../../engine/slice-reconcile';
import { SliceRefusal } from '../../engine/slices';
import type { AppDeps } from '../app';
import { refuse } from '../errorReply';
import { fingerprintOf, parseAcceptBody, receipt, writeIntent, type AcceptBody } from '../funding/accept';
import { gatherEvidence, type FundingPorts } from '../funding/evidence';
import type { LedgerView } from '../funding/gates';
import { judge } from '../funding/judge';
import { PREVIEW_TTL_MS, PreviewRegistry, previewView, type Preview } from '../funding/previews';
import { gateFundingReads } from '../funding/reads';
import { parsePreviewRequest, type PreviewRequest } from '../funding/request';
import { activeDealsOn } from '../manualConflicts';

const ledgerView = (store: Store): LedgerView => ({
  reconcile: (contract, actual) => (store.slices.book(contract) ? reconcileContract(store.slices.contractState(contract), actual) : null),
  activeDeals: (contracts) => activeDealsOn(store, contracts),
});

export function fundingIntentRoutes(deps: AppDeps) {
  const previews = new PreviewRegistry();
  return async function routes(app: FastifyInstance): Promise<void> {
    const ready = (): { store: Store; now: () => number; ports: FundingPorts } => {
      if (!deps.engine) throw new CoreError('the engine is not running', 'not-configured');
      if (!deps.funding) throw new CoreError('funding history is not available on this install', 'not-configured');
      const { history, legOf, reads } = deps.funding;
      return { store: deps.engine.store, now: () => deps.engine!.clock.now(), ports: { history, legOf, reads: reads ?? gateFundingReads(deps.getClients) } };
    };

    const preview = async (request: PreviewRequest): Promise<Preview> => {
      const { store, now, ports } = ready();
      const generation = store.admission.read().generation;
      const evidence = await gatherEvidence(ports, request, now);
      // Admission is judged as of the round, at the generation it began under.
      const admission = store.admission.read();
      const judgement = judge(request, evidence, ledgerView(store), admission.generation === generation ? admission : { ...admission, open: false, reason: 'closed' });
      return previews.mint(request, judgement, evidence.readAt, generation, now());
    };

    const again = async (reply: FastifyReply, label: string, message: string, request: PreviewRequest, next?: Preview) =>
      reply.code(409).send({ ok: false, error: { category: 'validation', label, message, retryable: true }, preview: previewView(next ?? await preview(request)) });

    app.post('/funding/preview', async (req, reply) => reply.ok(previewView(await preview(parsePreviewRequest(req.body)))));

    app.post('/funding/intents', async (req, reply) => {
      const body: AcceptBody = parseAcceptBody(req.body);
      const { store, now } = ready();
      const answerExisting = (intent: NonNullable<ReturnType<Store['fundingIntents']['get']>>) =>
        intent.fingerprint === fingerprintOf(body)
          ? reply.code(200).send({ ok: true, data: { ...receipt(store, intent), duplicate: true } })
          : refuse(reply, { code: 409, category: 'validation', label: 'intent-conflict', retryable: false,
            message: `intent ${body.intentId} was already accepted with different content; nothing was changed` });
      const existing = store.fundingIntents.get(body.intentId);
      if (existing) return answerExisting(existing);

      const confirmed = previews.get(body.previewId);
      if (!confirmed) return refuse(reply, { code: 409, category: 'validation', label: 'preview-unknown', retryable: false, message: 'this preview is unknown or was forgotten; preview again' });
      if (!body.authorizeConversion) return refuse(reply, { code: 409, category: 'validation', label: 'conversion-unauthorized', retryable: false, message: 'the maker expiry converts the unfilled remainder to taker; it must be authorized' });
      if (!body.acknowledgeRisks) return refuse(reply, { code: 409, category: 'validation', label: 'risks-unacknowledged', retryable: false, message: 'the listed risks must be acknowledged' });
      if (body.contentHash !== confirmed.contentHash) return refuse(reply, { code: 409, category: 'validation', label: 'preview-mismatch', retryable: false, message: 'the confirmed content is not this preview' });
      if (confirmed.judgement.blockers.length) return refuse(reply, { code: 409, category: 'validation', label: 'preview-blocked', retryable: false, message: 'this preview was not acceptable' });
      if (store.fundingIntents.byPreview(confirmed.id)) return refuse(reply, { code: 409, category: 'validation', label: 'preview-consumed', retryable: false, message: 'this preview was already accepted under another intent' });
      if (now() >= confirmed.expiresAt) return again(reply, 'preview-expired', 'the preview expired; confirm the new one', confirmed.request);

      const fresh = await preview(confirmed.request);
      const at = now();
      if (at >= confirmed.expiresAt || at >= fresh.readAt + PREVIEW_TTL_MS) return again(reply, 'preview-expired', 'the preview expired while its evidence was re-read; confirm the new one', confirmed.request, fresh);
      if (fresh.judgement.blockers.length) return again(reply, 'admission-refused', fresh.judgement.blockers.map((b) => b.message).join('; '), confirmed.request, fresh);
      if (fresh.contentHash !== confirmed.contentHash) return again(reply, 'preview-changed', 'what you confirmed has changed; confirm the new preview', confirmed.request, fresh);

      let written;
      try {
        written = writeIntent(store, confirmed, fresh.judgement.plan!, body, at);
      } catch (err) {
        if (!(err instanceof SliceRefusal)) throw err;
        return refuse(reply, { code: 409, category: 'validation', label: `slice-${err.code}`, retryable: false, message: `${err.message}; nothing was created` });
      }
      if (!written.ok) return refuse(reply, { code: 409, category: 'validation', label: 'admission-closed', retryable: false, message: `new funding opens are not admitted now (${written.state.reason}); nothing was created` });
      const outcome = written.value;
      if (outcome.kind === 'existing') return answerExisting(outcome.intent);
      if (outcome.kind === 'preview-consumed') return refuse(reply, { code: 409, category: 'validation', label: 'preview-consumed', retryable: false, message: 'this preview was already accepted under another intent' });
      if (outcome.kind === 'conflict') return refuse(reply, { code: 409, category: 'validation', label: 'active-deal', retryable: false, message: `an unfinished deal started on these contracts meanwhile (${outcome.deals.join(', ')}); nothing was created` });
      deps.engine!.wake?.();
      return reply.code(202).send({ ok: true, data: receipt(store, outcome.intent) });
    });

    app.get('/funding/intents/:id', async (req, reply) => {
      const { store } = ready();
      const intent = store.fundingIntents.get((req.params as { id: string }).id);
      if (!intent) return refuse(reply, { code: 404, category: 'validation', label: 'intent-unknown', retryable: false, message: 'no intent with this id was accepted by this ledger' });
      return reply.ok(receipt(store, intent));
    });
  };
}
