import type { HistoryDays } from '../../../../src/core/funding/history';
import { useCandidateIntents } from '../../api/fundingIntents';
import type { BoardLegHistory, BoardRow, BoardWindow } from '../../api/fundingOpportunities';
import { fmtTime, toDate } from '../../lib/fmt';
import { FundingOrderForm } from './FundingOrderForm';
import { dealSummary } from './FundingReceiptView';
import { useFundingSubmissions } from './FundingSubmissions';
import { coverageLabel, micro, pct, pctExact, reasonText, windowValue } from './labels';

const section = 'mt-4 border-t border-ink-800 pt-3';
const link = 'text-link underline decoration-link/40 underline-offset-2';

const goTo = (tab: string) => window.dispatchEvent(new CustomEvent('crossex:open-tab', { detail: tab }));

function Leg({ leg }: { leg: BoardLegHistory | undefined }) {
  if (!leg) return <span className="text-warning">UNKNOWN</span>;
  if (leg.annualized === null) return <span className="text-warning">{coverageLabel(leg.coverage)}</span>;
  return <span className="num"><span className="whitespace-nowrap">{pct(leg.total!)} ·</span> <span className="whitespace-nowrap">{pct(leg.annualized)}</span></span>;
}

function WindowRow({ w }: { w: BoardWindow }) {
  const value = windowValue(w);
  return (
    <tr className="border-t border-ink-800 align-top">
      <td className="py-1 pr-2">{w.days}d</td>
      <td className="num whitespace-nowrap py-1 pr-2">{w.netTotal === null ? value.text : pct(w.netTotal)}</td>
      <td className={`num whitespace-nowrap py-1 pr-2 ${value.known ? '' : 'text-warning'}`}>{value.text}</td>
      <td className="py-1 pr-2"><Leg leg={w.legs?.short} /></td>
      <td className="py-1 pr-2"><Leg leg={w.legs?.long} /></td>
      <td className="py-1">{coverageLabel(w.coverage)}</td>
    </tr>
  );
}

/**
 * The ledger's accepted intents for this pair that this browser has no record
 * of (another browser, cleared storage): shown by exact id, claimed by nothing,
 * and no reason to open or refuse a new one (ticket 14).
 */
function LedgerIntents({ candidateId }: { candidateId: string }) {
  const { data, isError } = useCandidateIntents(candidateId);
  const known = new Set(useFundingSubmissions().forCandidate(candidateId).map((s) => s.record.body.intentId));
  const others = (data ?? []).filter((r) => !known.has(r.intentId));
  if (isError) return <p className={`mt-2 ${micro}`}>The ledger's earlier opens of this pair could not be read.</p>;
  if (!others.length) return null;
  return (
    <div className="mt-2">
      <p className={micro}>Opens of this pair recorded in the ledger:</p>
      <ul aria-label="Recorded opens" className={micro}>
        {others.map((r) => (
          <li key={r.intentId} className="num">
            {r.intentId} · {dealSummary(r)} of {r.deal.targetQty} · {fmtTime(toDate(r.acceptedAt))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The selected pair, both legs fixed as listed: its history and current-rate
 * evidence, and the form that opens exactly this pair through a preview.
 */
export function CandidateDetail({ row, days, snapshotId, admissionOpen }: {
  row: BoardRow; days: HistoryDays; snapshotId: string | null; admissionOpen: boolean;
}) {
  const selectedLegs = row.windows.find((w) => w.days === days)?.legs;
  const unranked = row.windows.filter((w) => w.reasons.length > 0);
  return (
    <aside aria-label="Candidate detail" className="min-w-0 rounded border border-ink-800 p-3 text-[12px]">
      <h3 className="text-[14px] font-semibold text-ink-50">{row.underlying}</h3>
      <p className="mt-1">
        <span className="text-guava">Short {row.short.venue} {row.short.contractId}</span>
        <span className="mx-1 text-ink-500">→</span>
        <span className="text-grass">Long {row.long.venue} {row.long.contractId}</span>
      </p>
      <p className={micro}>Direction is fixed: the short leg receives a positive spread. Snapshot {snapshotId ?? 'none'}.</p>

      <div className="mt-3 overflow-x-auto">
        <table aria-label="History windows" className="w-full">
          <thead className={`text-left ${micro}`}>
            <tr className="[&>th]:pb-1 [&>th]:pr-2 [&>th]:font-normal">
              <th>Window</th><th>Net total</th><th>Net APR</th><th>Short total · APR</th><th>Long total · APR</th><th>Coverage</th>
            </tr>
          </thead>
          <tbody>{row.windows.map((w) => <WindowRow key={w.days} w={w} />)}</tbody>
        </table>
      </div>
      {unranked.length > 0 && (
        <ul aria-label="Why not ranked" className={`mt-1 ${micro}`}>
          {unranked.map((w) => (
            <li key={w.days}>{w.days}d not ranked: {w.reasons.map((r) => reasonText(r, row.underlying)).join('; ')}</li>
          ))}
        </ul>
      )}
      {selectedLegs && (
        <p className={`mt-1 ${micro}`}>
          Verified {fmtTime(toDate(selectedLegs.short.verifiedAt))} (short) / {fmtTime(toDate(selectedLegs.long.verifiedAt))} (long)
        </p>
      )}

      <div className={section}>
        <h4 className="font-semibold text-ink-100">Current period</h4>
        {row.current ? (
          <>
            {(['short', 'long'] as const).map((side) => {
              const q = row.current![side];
              return (
                <p key={side} className="num">
                  {side === 'short' ? 'Short' : 'Long'} {pctExact(q.rate)}% / {q.intervalHours}h <span className={micro}>read {fmtTime(toDate(q.at))}</span>
                </p>
              );
            })}
            <p className="num">Net {pct(row.current.netAnnualized)} APR at each leg&apos;s own interval</p>
            {row.current.reversed && (
              <p className="text-warning">Current spread runs opposite to the {days}d history — a hint only; the pair is not swapped or re-ranked.</p>
            )}
          </>
        ) : (
          <p className={micro}>No current quote for both legs.</p>
        )}
      </div>

      <div className={section}>
        <h4 className="font-semibold text-ink-100">Execution limits</h4>
        {row.executionBlockers.length ? (
          <ul className="list-disc pl-4">{row.executionBlockers.map((b) => <li key={b}>{reasonText(b, row.underlying)}</li>)}</ul>
        ) : (
          <p className={micro}>None known from the listing. Fees, FX, margin and positions are checked only at preview; history-eligible is not permission to open.</p>
        )}
      </div>

      <div className={section}>
        <h4 className="font-semibold text-ink-100">Open this pair</h4>
        <p className={micro}>Costs, sizing and admission are known only from a preview: every figure is read fresh and checked again on acceptance.</p>
        {snapshotId ? (
          // A new pair or window is a new draft; nothing typed carries over.
          <FundingOrderForm key={`${row.id}/${days}`} row={row} days={days} snapshotId={snapshotId} admissionOpen={admissionOpen} />
        ) : (
          <p className={micro}>No history snapshot is published: nothing can be previewed.</p>
        )}
        <LedgerIntents candidateId={row.id} />
      </div>

      <div className={section}>
        <p className={micro}>
          Held positions and their risk:{' '}
          <button type="button" className={link} onClick={() => goTo('positions')}>Go to Positions</button> ·{' '}
          <button type="button" className={link} onClick={() => goTo('risk')}>Go to Risk</button>
        </p>
      </div>
    </aside>
  );
}
