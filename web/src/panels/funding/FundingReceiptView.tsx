import { FINAL_MODES, type FundingReceipt } from '../../api/fundingIntents';
import { fmtTime, toDate } from '../../lib/fmt';
import { useTradeFlowOptional } from '../../trade/TradeFlow';
import type { Submission } from './FundingSubmissions';
import { decimalSign, micro } from './labels';

type Order = FundingReceipt['deal']['orders'][number];

/** One line for a receipt in a list: mode and each leg's real fill. */
export const dealSummary = ({ deal }: FundingReceipt): string => `${deal.mode} · maker ${deal.aFilled} / hedge ${deal.bFilled}`;

/** An order's state as the ledger recorded it; an unclassifiable venue status verbatim. */
const orderNote = (o: Order): string =>
  o.quarantinedStatus !== null ? `quarantined: venue status "${o.quarantinedStatus}"` : o.closeReason ?? o.venueReason ?? '';

/**
 * The accepted intent's deal as the ledger records it (tickets 13/14). Fills
 * are the real per-leg totals, never the target or what is reserved in
 * flight; a finished deal says what it left unfilled or unhedged. Nothing here
 * adds or unwinds orders: the deal view holds the engine's own controls.
 */
export function FundingReceiptView({ receipt, onDismiss }: { receipt: FundingReceipt; onDismiss?: () => void }) {
  const flow = useTradeFlowOptional();
  const { deal } = receipt;
  const report = deal.report as { reason?: string } | null;
  const done = FINAL_MODES.has(deal.mode);
  const rows: Array<[string, string]> = [
    ['Mode', deal.mode],
    ['Target', deal.targetQty],
    ['Maker leg filled', deal.aFilled],
    ['Hedge leg filled', deal.bFilled],
    ['Maker leg unfilled', deal.aUnfilled],
    ['Filled, not hedged', deal.filledGap],
    ['In flight, not filled', `maker ${deal.aReserved} · hedge ${deal.bReserved}`],
    ['Maker deadline', fmtTime(toDate(deal.deadlineAt))],
  ];
  return (
    <div className="mt-2">
      <p role="status" className="text-grass">Accepted as intent {receipt.intentId} · deal {receipt.dealId}</p>
      <table aria-label="Deal" className="mt-1">
        <tbody>
          {rows.map(([k, v]) => <tr key={k}><td className={`pr-3 ${micro}`}>{k}</td><td className="num">{v}</td></tr>)}
          {deal.haltReason && <tr><td className={`pr-3 ${micro}`}>Halted</td><td>{deal.haltReason}</td></tr>}
          {report?.reason && <tr><td className={`pr-3 ${micro}`}>Report</td><td>{report.reason}</td></tr>}
        </tbody>
      </table>
      {deal.orders.length > 0 && (
        <table aria-label="Orders" className={`mt-1 ${micro}`}>
          <tbody>
            {deal.orders.map((o) => (
              <tr key={o.clientId} className={o.quarantinedStatus !== null ? 'text-guava' : ''}>
                <td className="pr-2">{o.leg === 'A' ? 'maker leg' : 'hedge leg'} {o.kind}</td>
                <td className="num pr-2">{o.cumQty}/{o.qty}</td>
                <td className="pr-2">{o.state}</td>
                <td>{orderNote(o)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {done && decimalSign(deal.filledGap) !== 0 && (
        <p role="alert" className="mt-1 text-warning">Finished with {deal.filledGap} filled but not hedged (residual or dust): this deal trades no more.</p>
      )}
      {done && decimalSign(deal.aUnfilled) === 1 && <p className="mt-1 text-warning">Finished {deal.aUnfilled} short of the target.</p>}
      {!done && <p className={micro}>{deal.mode === 'STOPPING' || deal.mode === 'HALTED' ? 'Stopping: fills can still land until it is DONE.' : 'Running: fills can still change.'}</p>}
      <p className={micro}>
        Accepted is not filled, and DONE is not proof of a full fill: compare both legs above. Nothing here adds or unwinds orders; the engine
        keeps hedging what filled.
      </p>
      <div className="mt-1 flex gap-3">
        {flow && <button type="button" className="text-link underline" onClick={() => flow.openDeal(receipt.dealId)}>Open the deal view</button>}
        {done && onDismiss && <button type="button" className="text-link underline" onClick={onDismiss}>Dismiss</button>}
      </div>
    </div>
  );
}

/** One intent this page sent, by its id, whatever is known of it so far. */
export function SubmissionCard({ submission, onDismiss }: { submission: Submission; onDismiss: (intentId: string) => void }) {
  const { record, state } = submission;
  const id = record.body.intentId;
  if (state.kind === 'accepted') return <FundingReceiptView receipt={state.receipt} onDismiss={() => onDismiss(id)} />;
  const text = {
    sending: `Sending intent ${id}…`,
    checking: `Intent ${id}: looking up its result by id…`,
    pending: `Intent ${id} has no known result yet: not accepted so far, but it may still be accepted${
      state.kind === 'pending' && state.until !== null ? ` until ${fmtTime(toDate(state.until))}` : ''}. Looking it up by its id; nothing is resent.`,
    'lookup-failed': `Intent ${id}: its result could not be looked up (${state.kind === 'lookup-failed' ? state.error : ''}). Retrying; nothing new may open until it is known.`,
  }[state.kind];
  return <p role="alert" className="mt-2 text-warning">{text}</p>;
}
