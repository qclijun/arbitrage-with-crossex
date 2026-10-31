import { useId } from 'react';
import type { HistoryDays } from '../../../../src/core/funding/history';
import type { BoardRow } from '../../api/fundingOpportunities';
import { HoldToConfirmButton } from '../../components/HoldToConfirmButton';
import { SubmissionCard } from './FundingReceiptView';
import { useFundingSubmissions } from './FundingSubmissions';
import { decimalSign, micro } from './labels';
import { TIMEOUT_RANGE, type OrderDraft } from './orderDraft';
import { PreviewSummary, warningText } from './PreviewSummary';
import { useFundingOrder } from './useFundingOrder';

const input = 'input num h-[26px] w-24 !px-2 !py-0 text-[11px]';

function Field({ label, value, error, disabled, onChange, placeholder }: {
  label: string; value: string; error?: string; disabled: boolean; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className={`flex flex-col gap-0.5 ${micro}`}>
      {label}
      <input type="text" inputMode="decimal" autoComplete="off" aria-label={label} value={value} disabled={disabled} placeholder={placeholder}
        aria-invalid={value !== '' && !!error} onChange={(e) => onChange(e.target.value)} className={input} />
      {value !== '' && error && <span className="text-guava">{error}</span>}
    </label>
  );
}

type TextField = Exclude<keyof OrderDraft, 'makerLeg'>;

/** The typed fields in form order; `makerLeg` is the radio pair below them. */
const fieldsFor = (underlying: string): { key: TextField; label: string; placeholder?: string }[] => [
  { key: 'quantity', label: `Quantity (${underlying})` },
  { key: 'leverageShort', label: 'Short leverage' },
  { key: 'leverageLong', label: 'Long leverage' },
  { key: 'makerPrice', label: 'Maker price', placeholder: 'best' },
  { key: 'timeoutSec', label: 'Maker timeout (s)' },
  { key: 'holdDays', label: 'Hold days' },
];

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
  const previewNeedsId = useId();
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
  const fields = fieldsFor(row.underlying);
  const missing = [...fields.filter((f) => errors[f.key]).map((f) => f.label), ...(errors.makerLeg ? ['Maker leg'] : [])];
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
            onChange={(v) => order.edit(f.key, v)} />
        ))}
      </div>
      <p className={`mt-1 ${micro}`}>Maker timeout {TIMEOUT_RANGE.min}–{TIMEOUT_RANGE.max} s ({TIMEOUT_RANGE.default} default). Hold days only shape the scenarios below.</p>
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
        <button type="button" className="btn" disabled={frozen || stage.kind === 'previewing' || missing.length > 0}
          aria-describedby={missing.length > 0 && !frozen ? previewNeedsId : undefined} onClick={() => void order.requestPreview()}>
          Preview
        </button>
        {missing.length > 0 && !frozen && <span id={previewNeedsId} className={micro}>Preview needs: {missing.join(', ')}</span>}
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
