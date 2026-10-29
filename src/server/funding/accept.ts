/**
 * Accepting a funding intent (ticket 12): the one write. Inside the admission
 * transaction — open, at the preview's generation — it re-checks the intent
 * id, the preview and the contracts with no await, then writes the slice, the
 * deal (with its leverage targets for the engine) and the intent record
 * together, or nothing. The route only wakes the engine afterwards.
 */
import { createHash } from 'node:crypto';
import { CoreError } from '../../core/errors';
import type { Admitted } from '../../engine/admission';
import type { Store } from '../../engine/db';
import { project } from '../../engine/decide';
import type { FundingIntentRow } from '../../engine/funding-intents';
import type { PairRow } from '../../engine/types';
import { activeDealsOn } from '../manualConflicts';
import type { DealPlan } from './judge';
import type { Preview } from './previews';

export interface AcceptBody {
  /** The client's idempotency key for this intent. */
  intentId: string;
  previewId: string;
  /** The preview content the user confirmed, by hash. */
  contentHash: string;
  /** Required: the unfilled maker remainder converts to taker at expiry. */
  authorizeConversion: boolean;
  /** Required: the acknowledged risks listed in the preview's warnings. */
  acknowledgeRisks: boolean;
}

const INTENT_ID = /^[a-zA-Z0-9-]{6,36}$/;

export function parseAcceptBody(body: unknown): AcceptBody {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad = (message: string) => new CoreError(message, 'validation');
  if (typeof b.intentId !== 'string' || !INTENT_ID.test(b.intentId)) throw bad('intentId must be 6-36 chars of [a-zA-Z0-9-]');
  if (typeof b.previewId !== 'string' || typeof b.contentHash !== 'string') throw bad('previewId and contentHash are required');
  if (typeof b.authorizeConversion !== 'boolean' || typeof b.acknowledgeRisks !== 'boolean') {
    throw bad('authorizeConversion and acknowledgeRisks must be true or false');
  }
  const { intentId, previewId, contentHash, authorizeConversion, acknowledgeRisks } = b;
  return { intentId, previewId, contentHash, authorizeConversion, acknowledgeRisks };
}

/** Everything but the id: a retry with the same id must carry exactly this. */
export const fingerprintOf = (b: AcceptBody): string =>
  createHash('sha256').update(JSON.stringify([b.previewId, b.contentHash, b.authorizeConversion, b.acknowledgeRisks])).digest('hex');

export type WriteOutcome =
  | { kind: 'accepted' | 'existing'; intent: FundingIntentRow }
  | { kind: 'preview-consumed' }
  | { kind: 'conflict'; deals: string[] };

/** Where a funding deal and its slice came from, as both record it. */
function origin(preview: Preview, intentId: string) {
  const { snapshotId, windowDays } = preview.request;
  return { intentId, candidateId: preview.judgement.content.candidateId, snapshotId, windowDays };
}

function dealRow(id: string, plan: DealPlan, preview: Preview, intentId: string, now: number): PairRow {
  return {
    id, mode: 'OPENING', a: plan.a, b: plan.b, targetQty: plan.qty, limitPrice: plan.price,
    pricePolicy: 'fixed', autoPricePolicy: 'touch', deadlineAt: now + plan.timeoutSec * 1000,
    makerNotBefore: 0, hedgeNotBefore: 0, pocRejects: 0, hedgeRejectStreak: 0, repriceCount: 0,
    lastMakerPlacementAt: 0, postOnlyRejects: 0, bookOutageStartedAt: 0,
    // MARKET IOC clips and hedge, as confirmed: no price band is claimed.
    maxClip: null, clipBandBp: null, haltReason: null, reportJson: null, createdAt: now,
    purpose: 'funding-two-leg',
    purposeContext: JSON.stringify(origin(preview, intentId)),
    leverage: [
      { leg: 'A', target: plan.leverage.a, state: 'pending', previous: null, detail: null },
      { leg: 'B', target: plan.leverage.b, state: 'pending', previous: null, detail: null },
    ],
  };
}

export function writeIntent(store: Store, preview: Preview, plan: DealPlan, body: AcceptBody, now: number): Admitted<WriteOutcome> {
  return store.admission.admit<WriteOutcome>(preview.generation, () => {
    const existing = store.fundingIntents.get(body.intentId);
    if (existing) return { kind: 'existing', intent: existing };
    if (store.fundingIntents.byPreview(preview.id)) return { kind: 'preview-consumed' };
    const deals = activeDealsOn(store, [plan.a.contract, plan.b.contract]);
    if (deals.length) return { kind: 'conflict', deals };
    const dealId = `fi-${body.intentId}`;
    const sliceId = `fs-${body.intentId}`;
    const { request } = preview;
    store.slices.create({
      id: sliceId, kind: 'funding-two-leg', now, observed: plan.observed, source: origin(preview, body.intentId),
      legs: [{ leg: 'short', contract: request.short.symbol, side: 'short' }, { leg: 'long', contract: request.long.symbol, side: 'long' }],
    });
    store.createPair(dealRow(dealId, plan, preview, body.intentId, now));
    store.slices.attach(dealId, sliceId, 'open');
    const intent: FundingIntentRow = {
      id: body.intentId, fingerprint: fingerprintOf(body), previewId: preview.id, candidateId: preview.judgement.content.candidateId,
      dealId, sliceId, content: preview.judgement.content, acceptedAt: now,
    };
    store.fundingIntents.insert(intent);
    return { kind: 'accepted', intent };
  });
}

/** The durable receipt: the intent as confirmed and its deal as it stands now,
 * finished or not. */
export function receipt(store: Store, intent: FundingIntentRow) {
  const pair = store.getPair(intent.dealId)!;
  const p = project(pair, store.listOrders(pair.id));
  return {
    intentId: intent.id, dealId: intent.dealId, sliceId: intent.sliceId, candidateId: intent.candidateId,
    acceptedAt: intent.acceptedAt, content: intent.content,
    deal: {
      mode: pair.mode, deadlineAt: pair.deadlineAt, targetQty: pair.targetQty, aFilled: p.aFilled, bFilled: p.bFilled,
      unhedged: p.unhedged, haltReason: pair.haltReason, leverage: pair.leverage ?? null,
      report: pair.reportJson ? JSON.parse(pair.reportJson) : null,
    },
  };
}
