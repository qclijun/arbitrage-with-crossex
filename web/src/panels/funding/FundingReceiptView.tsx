import { useFundingReceipt, type FundingReceipt } from '../../api/fundingIntents';
import { fmtTime, toDate } from '../../lib/fmt';

const micro = 'text-[11px] text-ink-400';

/**
 * The accepted intent's deal as the ledger records it, polled while this page
 * stays open (ticket 13). Fills are the real per-leg totals, never the target;
 * refreshing the page loses this view until ticket 14 restores it by id.
 */
export function FundingReceiptView({ accepted }: { accepted: FundingReceipt }) {
  const { data } = useFundingReceipt(accepted.intentId);
  const r = data ?? accepted;
  const { deal } = r;
  const report = deal.report as { reason?: string } | null;
  const rows: Array<[string, string]> = [
    ['Mode', deal.mode],
    ['Target', deal.targetQty],
    ['Maker leg filled', deal.aFilled],
    ['Hedge leg filled', deal.bFilled],
    ['Unhedged', deal.unhedged],
    ['Maker deadline', fmtTime(toDate(deal.deadlineAt))],
  ];
  return (
    <div className="mt-2">
      <p role="status" className="text-emerald-300">Accepted as intent {r.intentId} · deal {r.dealId}</p>
      <table aria-label="Deal" className="mt-1">
        <tbody>
          {rows.map(([k, v]) => <tr key={k}><td className={`pr-3 ${micro}`}>{k}</td><td className="num">{v}</td></tr>)}
          {deal.haltReason && <tr><td className={`pr-3 ${micro}`}>Halted</td><td>{deal.haltReason}</td></tr>}
          {report?.reason && <tr><td className={`pr-3 ${micro}`}>Report</td><td>{report.reason}</td></tr>}
        </tbody>
      </table>
      <p className={micro}>
        Accepted is not filled, and DONE is not proof of a full fill: compare both legs above. Nothing here adds or unwinds orders; the engine
        keeps hedging what filled.
      </p>
    </div>
  );
}
