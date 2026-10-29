import type { HistoryDays } from '../../../../src/core/funding/history';
import type { BoardRow } from '../../api/fundingOpportunities';
import { HoldToConfirmButton } from '../../components/HoldToConfirmButton';
import { SubmissionCard } from './FundingReceiptView';
import { useFundingSubmissions } from './FundingSubmissions';
import { decimalSign } from './labels';
import { TIMEOUT_RANGE, type OrderDraft } from './orderDraft';
import { PreviewSummary, warningText } from './PreviewSummary';
import { useFundingOrder } from './useFundingOrder';

const micro = 'text-[11px] text-ink-400';
const input = 'input num h-[26px] w-24 !px-2 !py-0 text-[11px]';

function Field({ label, value, error, disabled, onChange, placeholder }: {
  label: string; value: string; error?: string; disabled: boolean; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className={`flex flex-col gap-0.5 ${micro}`}>
      {label}
      <input type="text" inputMode="decimal" autoComplete="off" aria-label={label} value={value} disabled={disabled} placeholder={placeholder}
        aria-invalid={value !== '' && !!error} onChange={(e) => onChange(e.target.value)} className={input} />
      {value !== '' && error && <span className="text-rose-300">{error}</span>}
    </label>
  );
}

/**
 * Open this exact pair (ticket 13): the user types every number, previews
 * through ticket 12, confirms what the server bound, and holds to accept.
 * The server re-checks everything; this form never decides admission. An
 * intent sent for this pair is shown, by its id, in place of a new draft (ticket 14).
 */
export function FundingOrderForm({ row, days, snapshotId, admissionOpen, holdMs, acceptTimeoutMs, now = Date.now }: {
  row: BoardRow; days: HistoryDays; snapshotId: string; admissionOpen: boolean; holdMs?: number; acceptTimeoutMs?: number; now?: () => number;
}) {
  const order = useFundingOrder({ row, days, snapshotId, now, acceptTimeoutMs });
  const submissions = useFundingSubmissions();
  const { draft, errors, stage } = order;
  const blocked = submissions.blocked;
  const sent = submissions.forCandidate(row.id);
  if (sent.length) {
    return <div>{sent.map((s) => <SubmissionCard key={s.record.body.intentId} submission={s} onDismiss={submissions.dismiss} />)}</div>;
  }
  if (!row.short.symbol || !row.long.symbol) {
    return <p className={micro}>This pair cannot be opened: a leg has no proven CrossEx symbol.</p>;
  }
  const frozen = order.locked;
  const setField = <K extends keyof OrderDraft>(k: K) => (v: OrderDraft[K]) => order.edit(k, v);
  const preview = stage.kind === 'preview' || stage.kind === 'sending' ? stage.preview : null;
  const historySign = decimalSign(row.windows.find((w) => w.days === days)?.netTotal);
  const negativeHistory = historySign === 0 || historySign === -1;
  const canHold = stage.kind === 'preview' && !!stage.preview.previewId && !order.expired && admissionOpen && !blocked
    && order.acks.conversion && order.acks.risks;

  return (
    <div aria-label="Open this pair" role="group" className="text-[12px]">
      <div className="flex flex-wrap gap-3">
        <Field label={`Quantity (${row.underlying})`} value={draft.quantity} error={errors.quantity} disabled={frozen} onChange={setField('quantity')} />
        <Field label="Short leverage" value={draft.leverageShort} error={errors.leverageShort} disabled={frozen} onChange={setField('leverageShort')} />
        <Field label="Long leverage" value={draft.leverageLong} error={errors.leverageLong} disabled={frozen} onChange={setField('leverageLong')} />
        <Field label="Maker price" value={draft.makerPrice} error={errors.makerPrice} disabled={frozen} onChange={setField('makerPrice')} placeholder="best" />
        <Field label="Maker timeout (s)" value={draft.timeoutSec} error={errors.timeoutSec} disabled={frozen} onChange={setField('timeoutSec')} />
        <Field label="Hold days" value={draft.holdDays} error={errors.holdDays} disabled={frozen} onChange={setField('holdDays')} />
      </div>
      <p className={micro}>Maker timeout {TIMEOUT_RANGE.min}–{TIMEOUT_RANGE.max} s ({TIMEOUT_RANGE.default} default). Hold days only shape the scenarios below.</p>
      <fieldset className="mt-2 flex gap-4" disabled={frozen}>
        <legend className={micro}>Maker leg (the other leg hedges as taker)</legend>
        {(['short', 'long'] as const).map((side) => (
          <label key={side} className="flex items-center gap-1.5">
            <input type="radio" name={`maker-${row.id}`} checked={draft.makerLeg === side} onChange={() => order.edit('makerLeg', side)}
              aria-label={`Maker: ${side} ${row[side].venue}`} />
            {side} {row[side].venue} {row[side].contractId}
          </label>
        ))}
      </fieldset>
      <button type="button" className="mt-2 rounded border border-ink-600 px-3 py-1" disabled={frozen || stage.kind === 'previewing' || Object.keys(errors).length > 0}
        onClick={() => void order.requestPreview()}>
        Preview
      </button>
      {stage.kind === 'draft' && stage.message && <p role="alert" className="mt-2 text-rose-300">{stage.message}</p>}
      {preview && (
        <>
          {stage.kind === 'preview' && stage.notice && <p role="alert" className="mt-2 text-amber-300">{stage.notice} — confirm the new preview.</p>}
          {stage.kind === 'preview' && stage.error && <p role="alert" className="mt-2 text-rose-300">{stage.error}</p>}
          <PreviewSummary preview={preview} />
          {(negativeHistory || preview.content.warnings.includes('scenario-not-positive')) && (
            <p role="alert" className="mt-2 font-semibold text-amber-300">
              {negativeHistory ? `The ${days}d historical spread is zero or negative. ` : ''}You may still confirm, at your own risk.
            </p>
          )}
          <ul className="mt-2 list-disc pl-4 text-ink-300">{preview.content.warnings.map((w) => <li key={w}>{warningText(w)}</li>)}</ul>
          <label className="mt-2 flex items-center gap-1.5">
            <input type="checkbox" checked={order.acks.conversion} disabled={frozen} onChange={(e) => order.setAcks((a) => ({ ...a, conversion: e.target.checked }))} />
            I authorize converting the unfilled maker remainder to taker after {preview.content.timeoutSec} s.
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={order.acks.risks} disabled={frozen} onChange={(e) => order.setAcks((a) => ({ ...a, risks: e.target.checked }))} />
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
      {blocked && <p role="alert" className="mt-2 text-rose-300">{blocked}</p>}
      {submissions.notices.filter((n) => n.candidateId === row.id).map((n) => <p key={n.text} role="status" className="mt-2 text-amber-300/90">{n.text}</p>)}
    </div>
  );
}
