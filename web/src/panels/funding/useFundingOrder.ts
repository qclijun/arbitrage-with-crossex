/**
 * The opportunity order flow (ticket 13) over ticket 12's protocol: draft →
 * preview (valid until the server's expiresAt) → confirm → accept. Any edit
 * drops the preview and both acknowledgements; a refusal that carries a new
 * preview replaces it and must be confirmed again. The acceptance is recorded
 * durably before its one send (ticket 14); a lost or 5xx answer is handed to
 * the page's submissions, which look it up by id. Nothing is retried or
 * re-created from here, and nothing here decides admission; the server does.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryDays } from '../../../../src/core/funding/history';
import { ApiError, readEvidence } from '../../api/client';
import { acceptFunding, previewFunding, type FundingPreview } from '../../api/fundingIntents';
import type { BoardRow } from '../../api/fundingOpportunities';
import { uuid } from '../../lib/uuid';
import { useFundingSubmissions } from './FundingSubmissions';
import { draftErrors, EMPTY_DRAFT, previewRequest, type OrderDraft } from './orderDraft';

export type OrderStage =
  | { kind: 'draft'; message?: string }
  | { kind: 'previewing' }
  | { kind: 'preview'; preview: FundingPreview; deadline: number; notice?: string; error?: string }
  | { kind: 'sending'; preview: FundingPreview; deadline: number; intentId: string };

export interface Acks { conversion: boolean; risks: boolean }
const NO_ACKS: Acks = { conversion: false, risks: false };

/**
 * The server's expiry on this browser's clock, never later than it can be.
 * The evidence read began after our request was sent, so the preview's life
 * runs out no later than `sentAt` plus that life; when the envelope carries the
 * server's clock (a refusal's preview does not), its count can only be earlier.
 */
function deadlineOf(preview: FundingPreview, sentAt: number, now: number): number {
  const bound = sentAt + (preview.expiresAt - preview.readAt);
  const serverNow = readEvidence(preview)?.ts;
  return serverNow === undefined ? bound : Math.min(bound, now + (preview.expiresAt - serverNow));
}

/** A refusal's `preview`, only when it has the shape of one. */
function previewIn(details: Record<string, unknown> | undefined): FundingPreview | undefined {
  const p = details?.preview as Partial<FundingPreview> | undefined;
  const ok = !!p && typeof p === 'object' && typeof p.expiresAt === 'number' && typeof p.readAt === 'number'
    && typeof p.contentHash === 'string' && !!p.content && Array.isArray(p.blockers);
  return ok ? (p as FundingPreview) : undefined;
}

/**
 * Only a 4xx is a definitive refusal; anything else may have been accepted.
 * `intent-conflict` says an intent with this id is already in the ledger: look it up.
 */
const definitive = (err: unknown): err is ApiError =>
  err instanceof ApiError && err.httpStatus !== undefined && err.httpStatus >= 400 && err.httpStatus < 500 && err.label !== 'intent-conflict';

export function useFundingOrder(opts: { row: BoardRow; days: HistoryDays; snapshotId: string; now: () => number; acceptTimeoutMs?: number }) {
  const { row, days, snapshotId, now, acceptTimeoutMs } = opts;
  const submissions = useFundingSubmissions();
  const [draft, setDraft] = useState<OrderDraft>(EMPTY_DRAFT);
  const [stage, setStage] = useState<OrderStage>({ kind: 'draft' });
  const [acks, setAcks] = useState<Acks>(NO_ACKS);
  const [clock, setClock] = useState(now());
  // A preview answer for an older draft is dropped, never shown.
  const seq = useRef(0);
  const sending = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setClock(now()), 250);
    return () => clearInterval(t);
  }, [now]);

  // A preview names its snapshot: a new snapshot makes it stale, though the draft stays.
  useEffect(() => {
    seq.current += 1;
    setAcks(NO_ACKS);
    setStage((s) => (s.kind === 'preview' || s.kind === 'previewing' ? { kind: 'draft' } : s));
  }, [snapshotId]);

  const locked = stage.kind === 'sending' || submissions.blocked !== null;
  const errors = draftErrors(draft);

  const edit = useCallback(<K extends keyof OrderDraft>(field: K, value: OrderDraft[K]) => {
    seq.current += 1;
    setDraft((d) => ({ ...d, [field]: value }));
    setAcks(NO_ACKS);
    setStage((s) => (s.kind === 'preview' || s.kind === 'previewing' || s.kind === 'draft' ? { kind: 'draft' } : s));
  }, []);

  const show = (preview: FundingPreview, sentAt: number, notice?: string) => {
    setAcks(NO_ACKS);
    setStage({ kind: 'preview', preview, deadline: deadlineOf(preview, sentAt, now()), notice });
  };

  const requestPreview = async () => {
    if (Object.keys(errors).length || locked) return;
    const request = ++seq.current;
    setAcks(NO_ACKS);
    setStage({ kind: 'previewing' });
    const sentAt = now();
    try {
      const preview = await previewFunding(previewRequest(row, days, snapshotId, draft));
      if (request === seq.current) show(preview, sentAt);
    } catch (err) {
      if (request === seq.current) setStage({ kind: 'draft', message: (err as Error).message });
    }
  };

  const confirm = async () => {
    const previewId = stage.kind === 'preview' ? stage.preview.previewId : null;
    // One send per confirmation, even if a second hold lands before the re-render.
    if (stage.kind !== 'preview' || !previewId || sending.current) return;
    const { preview, deadline } = stage;
    // The countdown ticks every 250 ms; the deadline is checked at the moment of confirming too.
    if (now() >= deadline) {
      setClock(now());
      return;
    }
    const body = { intentId: uuid(), previewId, contentHash: preview.contentHash,
      authorizeConversion: acks.conversion, acknowledgeRisks: acks.risks };
    const notRecorded = submissions.record(row.id, body);
    if (notRecorded !== null) {
      setStage({ ...stage, error: `Not sent: ${notRecorded}.` });
      return;
    }
    sending.current = true;
    seq.current += 1;
    setStage({ kind: 'sending', preview, deadline, intentId: body.intentId });
    const sentAt = now();
    try {
      const receipt = await acceptFunding(body, acceptTimeoutMs);
      submissions.settled(body.intentId, { receipt });
      setStage({ kind: 'draft' });
    } catch (err) {
      if (!definitive(err)) {
        submissions.settled(body.intentId, { unknown: true });
        setStage({ kind: 'draft' });
        return;
      }
      submissions.settled(body.intentId, { refused: true });
      const next = previewIn(err.details);
      if (next) show(next, sentAt, err.message);
      else setStage({ kind: 'draft', message: err.message });
    } finally {
      sending.current = false;
    }
  };

  const expired = (stage.kind === 'preview' || stage.kind === 'sending') && clock >= stage.deadline;
  return { draft, errors, edit, stage, acks, setAcks, locked, expired, clock, requestPreview, confirm };
}
