/**
 * The opportunity order flow (ticket 13) over ticket 12's protocol: draft →
 * preview (valid until the server's expiresAt) → confirm → accept. Any edit
 * drops the preview and both acknowledgements; a refusal that carries a new
 * preview replaces it and must be confirmed again. A lost or 5xx acceptance is
 * "result unknown": nothing is retried or re-created from here (ticket 14
 * owns looking it up). Nothing here decides admission; the server does.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryDays } from '../../../../src/core/funding/history';
import { ApiError, readEvidence } from '../../api/client';
import { acceptFunding, previewFunding, type FundingPreview, type FundingReceipt } from '../../api/fundingIntents';
import type { BoardRow } from '../../api/fundingOpportunities';
import { uuid } from '../../lib/uuid';
import { draftErrors, EMPTY_DRAFT, previewRequest, type OrderDraft } from './orderDraft';

export type OrderStage =
  | { kind: 'draft'; message?: string }
  | { kind: 'previewing' }
  | { kind: 'preview'; preview: FundingPreview; deadline: number; notice?: string }
  | { kind: 'sending'; preview: FundingPreview; deadline: number; intentId: string }
  | { kind: 'accepted'; receipt: FundingReceipt }
  | { kind: 'unknown'; intentId: string; message: string };

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

/** Only a 4xx is a definitive refusal; anything else may have been accepted. */
const definitive = (err: unknown): err is ApiError =>
  err instanceof ApiError && err.httpStatus !== undefined && err.httpStatus >= 400 && err.httpStatus < 500;

export function useFundingOrder(opts: {
  row: BoardRow; days: HistoryDays; snapshotId: string; now: () => number;
  /** Already accepted on this page: show its receipt, start nothing. */
  accepted?: FundingReceipt | null;
  onAccepted?: (receipt: FundingReceipt) => void;
  onUnknown?: (intentId: string) => void;
}) {
  const { row, days, snapshotId, now, accepted, onAccepted, onUnknown } = opts;
  const [draft, setDraft] = useState<OrderDraft>(EMPTY_DRAFT);
  const [stage, setStage] = useState<OrderStage>(accepted ? { kind: 'accepted', receipt: accepted } : { kind: 'draft' });
  const [acks, setAcks] = useState<Acks>(NO_ACKS);
  const [clock, setClock] = useState(now());
  // A preview answer for an older draft is dropped, never shown.
  const seq = useRef(0);

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

  const locked = stage.kind === 'sending' || stage.kind === 'accepted' || stage.kind === 'unknown';
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
    if (stage.kind !== 'preview' || !stage.preview.previewId) return;
    const { preview, deadline } = stage;
    // The countdown ticks every 250 ms; the deadline is checked at the moment of confirming too.
    if (now() >= deadline) {
      setClock(now());
      return;
    }
    const intentId = uuid();
    seq.current += 1;
    setStage({ kind: 'sending', preview, deadline, intentId });
    const sentAt = now();
    try {
      const receipt = await acceptFunding({ intentId, previewId: preview.previewId!, contentHash: preview.contentHash,
        authorizeConversion: acks.conversion, acknowledgeRisks: acks.risks });
      setStage({ kind: 'accepted', receipt });
      onAccepted?.(receipt);
    } catch (err) {
      if (!definitive(err)) {
        onUnknown?.(intentId);
        setStage({ kind: 'unknown', intentId, message: (err as Error).message });
        return;
      }
      const next = previewIn(err.details);
      if (next) show(next, sentAt, err.message);
      else setStage({ kind: 'draft', message: err.message });
    }
  };

  const expired = (stage.kind === 'preview' || stage.kind === 'sending') && clock >= stage.deadline;
  return { draft, errors, edit, stage, acks, setAcks, locked, expired, clock, requestPreview, confirm };
}
