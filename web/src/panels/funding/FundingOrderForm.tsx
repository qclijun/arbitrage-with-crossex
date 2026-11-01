import { useId } from 'react';
import type { HistoryDays } from '../../../../src/core/funding/history';
import type { BoardRow } from '../../api/fundingOpportunities';
import { useSymbolDetail, useVenueTouch } from '../../api/queries';
import { HoldToConfirmButton } from '../../components/HoldToConfirmButton';
import { TipLabel } from '../../components/Th';
import { fmtUsd } from '../../lib/fmt';
import { SubmissionCard } from './FundingReceiptView';
import { useFundingSubmissions } from './FundingSubmissions';
import { decimalSign, micro } from './labels';
import { DEFAULT_NOTIONAL_USD, leverageFor, quantityFor, TIMEOUT_RANGE, type OrderDraft } from './orderDraft';
import { PreviewSummary, warningText } from './PreviewSummary';
import { useFundingOrder } from './useFundingOrder';

const input = 'input num h-[26px] w-24 !px-2 !py-0 text-[11px]';

function Field({ label, value, error, disabled, onChange, placeholder, tip, hint }: {
  label: string; value: string; error?: string; disabled: boolean; onChange: (v: string) => void; placeholder?: string; tip?: string; hint?: string;
}) {
  const noteId = useId();
  const shown = value !== '' && error ? error : hint;
  return (
    <label className={`flex flex-col gap-0.5 ${micro}`}>
      {tip ? <TipLabel className="self-start" title={tip}>{label}</TipLabel> : label}
      <input type="text" inputMode="decimal" autoComplete="off" aria-label={label} value={value} disabled={disabled} placeholder={placeholder}
        aria-invalid={value !== '' && !!error} aria-describedby={shown ? noteId : undefined} onChange={(e) => onChange(e.target.value)} className={input} />
      {shown && <span id={noteId} className={shown === hint ? 'whitespace-nowrap' : 'text-guava'}>{shown}</span>}
    </label>
  );
}

type TextField = Exclude<keyof OrderDraft, 'makerLeg'>;

/** The typed fields in form order; `makerLeg` is the radio pair below them. */
const fieldsFor = (underlying: string): { key: TextField; label: string; placeholder?: string; tip?: string }[] => [
  { key: 'quantity', label: `Quantity (${underlying})` },
  { key: 'leverageShort', label: 'Short leverage' },
  { key: 'leverageLong', label: 'Long leverage' },
  { key: 'makerPrice', label: 'Maker price', placeholder: 'best' },
  { key: 'timeoutSec', label: 'Maker timeout (s)', tip: `${TIMEOUT_RANGE.min}–${TIMEOUT_RANGE.max} s, ${TIMEOUT_RANGE.default} by default.` },
  { key: 'holdDays', label: 'Hold days', tip: 'Only shapes the cost scenarios below.' },
];

type FormProps = {
  row: BoardRow; days: HistoryDays; snapshotId: string; admissionOpen: boolean; holdMs?: number; acceptTimeoutMs?: number; now?: () => number;
};

/**
 * Open this exact pair (ticket 13): the draft starts previewable — $10k per
 * leg at the short leg's mid, each leg's max leverage, short as maker, 30 hold
 * days — and the user edits any of it, previews through ticket 12, confirms
 * what the server bound, and holds to accept. The server re-checks everything;
 * this form never decides admission. An intent sent for this pair is shown, by
 * its id, in place of a new draft (ticket 14).
 */
export function FundingOrderForm({ row, days, snapshotId, admissionOpen, holdMs, acceptTimeoutMs, now = Date.now }: FormProps) {
  const submissions = useFundingSubmissions();
  const sent = submissions.forCandidate(row.id);
  // The draft's state outlives a sent intent (a refusal returns to it), but its
  // default reads run only while the draft is on screen.
  const drafting = sent.length === 0 && !!row.short.symbol && !!row.long.symbol;
  // Opportunities defaults: $10k per leg priced off the short leg's touch, each leg at its max leverage.
  const book = useVenueTouch(drafting ? row.short.symbol : null);
  const shortMax = useSymbolDetail(drafting ? row.short.symbol : null).data?.leverageMax;
  const longMax = useSymbolDetail(drafting ? row.long.symbol : null).data?.leverageMax;
  const mid = book.data?.mid;
  const order = useFundingOrder({ row, days, snapshotId, now, acceptTimeoutMs, suggested: {
    quantity: quantityFor(DEFAULT_NOTIONAL_USD, mid), leverageShort: leverageFor(shortMax), leverageLong: leverageFor(longMax) } });
  const { draft, errors, stage } = order;
  const blocked = submissions.blocked;
  if (sent.length) {
    return <div>{sent.map((s) => <SubmissionCard key={s.record.body.intentId} submission={s} onDismiss={submissions.dismiss} />)}</div>;
  }
  if (!row.short.symbol || !row.long.symbol) {
    return <p className={micro}>This pair cannot be opened: a leg has no proven CrossEx symbol.</p>;
  }
  const frozen = order.locked;
  const fields = fieldsFor(row.underlying);
  const needs = fields.filter((f) => errors[f.key]).map((f) => `${f.label} — ${errors[f.key]}`);
  const qty = Number(draft.quantity);
  const hints: Partial<Record<keyof OrderDraft, string>> = {
    quantity: mid ? (errors.quantity ? `short mid ${fmtUsd(mid)}` : `≈ ${fmtUsd(qty * mid, 0)} at short mid`) : book.isError ? 'no price read' : undefined,
    leverageShort: shortMax ? `max ${leverageFor(shortMax) ?? shortMax}×` : undefined,
    leverageLong: longMax ? `max ${leverageFor(longMax) ?? longMax}×` : undefined,
  };
  const preview = stage.kind === 'preview' || stage.kind === 'sending' ? stage.preview : null;
  const historySign = decimalSign(row.windows.find((w) => w.days === days)?.netTotal);
  const negativeHistory = historySign === 0 || historySign === -1;
  const canHold = stage.kind === 'preview' && !!stage.preview.previewId && !order.expired && admissionOpen && !blocked
    && order.acks.conversion && order.acks.risks;

  return (
    <div aria-label="Open this pair" role="group" className="mt-2 text-[12px]">
      <div className="flex flex-wrap gap-x-3 gap-y-2">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} value={draft[f.key]} error={errors[f.key]} disabled={frozen} placeholder={f.placeholder}
            tip={f.tip} hint={hints[f.key]} onChange={(v) => order.edit(f.key, v)} />
        ))}
      </div>
      <fieldset className="mt-2 flex gap-4" disabled={frozen}>
        <legend className={micro}>Maker leg (the other leg hedges as taker)</legend>
        {(['short', 'long'] as const).map((side) => (
          <label key={side} className="flex items-center gap-1.5">
            <input type="radio" className="chk" name={`maker-${row.id}`} checked={draft.makerLeg === side} onChange={() => order.edit('makerLeg', side)}
              aria-label={`Maker: ${side} ${row[side].venue}`} />
            {side} {row[side].venue} {row[side].contractId}
          </label>
        ))}
      </fieldset>
      <div className="mt-3 flex items-center gap-3">
        {/* An incomplete draft is aria-disabled, not disabled: the button stays focusable, so its
            hover/focus tip (also its accessible description) says why. Nothing is printed on the page. */}
        <button type="button" className="btn aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent"
          disabled={frozen || stage.kind === 'previewing'} aria-disabled={needs.length > 0 || undefined}
          title={needs.length > 0 && !frozen ? ['Preview needs', ...needs].join('\n') : undefined}
          onClick={() => void order.requestPreview()}>
          Preview
        </button>
      </div>
      {stage.kind === 'draft' && stage.message && <p role="alert" className="mt-2 text-guava">{stage.message}</p>}
      {preview && (
        <>
          {stage.kind === 'preview' && stage.notice && <p role="alert" className="mt-2 text-warning">{stage.notice} — confirm the new preview.</p>}
          {stage.kind === 'preview' && stage.error && <p role="alert" className="mt-2 text-guava">{stage.error}</p>}
          <PreviewSummary preview={preview} />
          {(negativeHistory || preview.content.warnings.includes('scenario-not-positive')) && (
            <p role="alert" className="mt-2 font-semibold text-warning">
              {negativeHistory ? `The ${days}d historical spread is zero or negative. ` : ''}You may still confirm, at your own risk.
            </p>
          )}
          <ul className="mt-2 list-disc pl-4 text-ink-300">{preview.content.warnings.map((w) => <li key={w}>{warningText(w)}</li>)}</ul>
          <label className="mt-2 flex items-center gap-1.5">
            <input type="checkbox" className="chk" checked={order.acks.conversion} disabled={frozen} onChange={(e) => order.setAcks((a) => ({ ...a, conversion: e.target.checked }))} />
            I authorize converting the unfilled maker remainder to taker after {preview.content.timeoutSec} s.
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="chk" checked={order.acks.risks} disabled={frozen} onChange={(e) => order.setAcks((a) => ({ ...a, risks: e.target.checked }))} />
            I accept the risks listed above.
          </label>
          <p className={micro}>
            {order.expired ? 'Preview expired — preview again.' : stage.kind === 'preview' ? `Valid for ${Math.max(0, Math.ceil((stage.deadline - order.clock) / 1000))} s.` : ''}
            {!admissionOpen && ' Manual opening is not enabled: this preview can only be observed.'}
          </p>
          <HoldToConfirmButton onConfirm={() => void order.confirm()} disabled={!canHold} holdMs={holdMs} className="mt-2">
            Hold to open
          </HoldToConfirmButton>
        </>
      )}
      {blocked && <p role="alert" className="mt-2 text-guava">{blocked}</p>}
      {submissions.notices.filter((n) => n.candidateId === row.id).map((n) => <p key={n.text} role="status" className="mt-2 text-warning">{n.text}</p>)}
    </div>
  );
}
