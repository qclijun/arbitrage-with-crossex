/**
 * Funding-opportunity preview, acceptance and receipt (ticket 12).
 *
 *   POST /api/funding/preview      fresh read-only evidence → content to confirm
 *   POST /api/funding/intents      accept a confirmed, still-valid preview
 *   GET  /api/funding/intents/:id  the durable receipt, finished deals included;
 *                                  not found, whether a late request may still land
 *   GET  /api/funding/intents?candidateId=  that candidate's receipts (ticket 14)
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
import type { FundingIntentRow } from '../../engine/funding-intents';
import { reconcileContract } from '../../engine/slice-reconcile';
import { SliceRefusal } from '../../engine/slices';
import type { AppDeps } from '../app';
import { refuse } from '../errorReply';
import { fingerprintOf, parseAcceptBody, receipt, writeIntent, type AcceptBody } from '../funding/accept';
import { gatherEvidence, type FundingPorts } from '../funding/evidence';
import type { LedgerView } from '../funding/gates';
import { judge } from '../funding/judge';
import { PREVIEW_TTL_MS, PreviewRegistry, previewView, type LateAcceptance, type Preview } from '../funding/previews';
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
      const ports = { history, legOf, reads: reads ?? gateFundingReads(deps.getClients) };
      return { store: deps.engine.store, now: () => deps.engine!.clock.now(), ports };
    };

    const preview = async (request: PreviewRequest): Promise<Preview> => {
      const { store, now, ports } = ready();
      const generation = store.admission.read().generation;
      const evidence = await gatherEvidence(ports, request, now);
      // Admission is judged as of the round, at the generation it began under.
      const admission = store.admission.read();
      const asOfRound = admission.generation === generation ? admission : { ...admission, open: false, reason: 'closed' as const };
      const judgement = judge(request, evidence, ledgerView(store), asOfRound);
      return previews.mint(request, judgement, evidence.readAt, generation, now());
    };

    /** 409, nothing written: a request the current state refuses. */
    const no = (reply: FastifyReply, label: string, message: string, extra?: Record<string, unknown>) =>
      refuse(reply, { code: 409, category: 'validation', label, message, retryable: extra !== undefined }, extra);

    /** 409 with a fresh preview of the same request, to confirm instead. */
    const refuseWithNewPreview = async (reply: FastifyReply, label: string, message: string, request: PreviewRequest, next?: Preview) =>
      no(reply, label, message, { preview: previewView(next ?? await preview(request)) });

    app.post('/funding/preview', async (req, reply) => reply.ok(previewView(await preview(parsePreviewRequest(req.body)))));

    app.post('/funding/intents', async (req, reply) => {
      const body: AcceptBody = parseAcceptBody(req.body);
      const { store, now } = ready();
      const answerExisting = (intent: FundingIntentRow) => intent.fingerprint === fingerprintOf(body)
        ? reply.ok({ ...receipt(store, intent), duplicate: true })
        : no(reply, 'intent-conflict', `intent ${body.intentId} was already accepted with different content; nothing was changed`);
      const consumed = () => no(reply, 'preview-consumed', 'this preview was already accepted under another intent');
      const existing = store.fundingIntents.get(body.intentId);
      if (existing) return answerExisting(existing);

      // Checks that need no evidence come first; none of them reads a venue.
      const confirmed = previews.get(body.previewId);
      if (!confirmed) return no(reply, 'preview-unknown', 'this preview is unknown or was forgotten; preview again');
      if (!body.authorizeConversion) {
        return no(reply, 'conversion-unauthorized', 'the maker expiry converts the unfilled remainder to taker; it must be authorized');
      }
      if (!body.acknowledgeRisks) return no(reply, 'risks-unacknowledged', 'the listed risks must be acknowledged');
      if (body.contentHash !== confirmed.contentHash) return no(reply, 'preview-mismatch', 'the confirmed content is not this preview');
      if (confirmed.judgement.blockers.length) return no(reply, 'preview-blocked', 'this preview was not acceptable');
      if (store.fundingIntents.byPreview(confirmed.id)) return consumed();
      if (now() >= confirmed.expiresAt) {
        return refuseWithNewPreview(reply, 'preview-expired', 'the preview expired; confirm the new one', confirmed.request);
      }

      // Every piece of evidence again, judged the same way.
      const fresh = await preview(confirmed.request);
      const at = now();
      if (at >= confirmed.expiresAt || at >= fresh.readAt + PREVIEW_TTL_MS) {
        return refuseWithNewPreview(reply, 'preview-expired', 'the preview expired while its evidence was re-read; confirm the new one',
          confirmed.request, fresh);
      }
      if (fresh.judgement.blockers.length) {
        const why = fresh.judgement.blockers.map((b) => b.message).join('; ');
        return refuseWithNewPreview(reply, 'admission-refused', why, confirmed.request, fresh);
      }
      if (fresh.contentHash !== confirmed.contentHash) {
        const why = 'what you confirmed has changed; confirm the new preview';
        return refuseWithNewPreview(reply, 'preview-changed', why, confirmed.request, fresh);
      }

      let written;
      try {
        written = writeIntent(store, confirmed, fresh.judgement.plan!, body, at);
      } catch (err) {
        if (!(err instanceof SliceRefusal)) throw err;
        return no(reply, `slice-${err.code}`, `${err.message}; nothing was created`);
      }
      if (!written.ok) {
        return no(reply, 'admission-closed', `new funding opens are not admitted now (${written.state.reason}); nothing was created`);
      }
      const outcome = written.value;
      if (outcome.kind === 'existing') return answerExisting(outcome.intent);
      if (outcome.kind === 'preview-consumed') return consumed();
      if (outcome.kind === 'conflict') {
        const deals = outcome.deals.join(', ');
        return no(reply, 'active-deal', `an unfinished deal started on these contracts meanwhile (${deals}); nothing was created`);
      }
      // Every refusal above came before the write; nothing after it may answer 4xx,
      // since the page releases an intent on a 4xx (ticket 14).
      deps.engine!.wake?.();
      return reply.code(202).ok(receipt(store, outcome.intent));
    });

    /**
     * Whether a request carrying this preview may still be accepted (ticket 14).
     * Acceptance writes synchronously only while `now < expiresAt`, so once the
     * server's clock reaches it, or the preview is consumed or unknown to this
     * process, no late request can ever be accepted with it.
     */
    const lateAcceptance = (store: Store, previewId: string, now: number): LateAcceptance => {
      const p = previews.get(previewId);
      if (!p) return { possible: false, reason: 'preview-unknown' };
      if (store.fundingIntents.byPreview(p.id)) return { possible: false, reason: 'preview-consumed' };
      if (now >= p.expiresAt) return { possible: false, reason: 'preview-expired' };
      return { possible: true, until: p.expiresAt };
    };

    // A candidate's accepted intents by exact id (ticket 14): what a page without
    // its own record can show; it claims nothing and admits nothing.
    app.get('/funding/intents', async (req, reply) => {
      const { store } = ready();
      const { candidateId } = req.query as { candidateId?: unknown };
      if (typeof candidateId !== 'string' || !candidateId) throw new CoreError('candidateId is required', 'validation');
      return reply.ok(store.fundingIntents.byCandidate(candidateId).map((intent) => receipt(store, intent)));
    });

    app.get('/funding/intents/:id', async (req, reply) => {
      const { store, now } = ready();
      const intent = store.fundingIntents.get((req.params as { id: string }).id);
      if (!intent) {
        const { previewId } = req.query as { previewId?: unknown };
        const extra = typeof previewId === 'string' ? { lateAcceptance: lateAcceptance(store, previewId, now()) } : undefined;
        return refuse(reply, { code: 404, category: 'validation', label: 'intent-unknown', retryable: false,
          message: 'no intent with this id was accepted by this ledger' }, extra);
      }
      return reply.ok(receipt(store, intent));
    });
  };
}
