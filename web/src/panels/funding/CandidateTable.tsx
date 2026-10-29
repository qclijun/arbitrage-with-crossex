import type { BoardRow, FundingBoard } from '../../api/fundingOpportunities';
import { VenueChip } from '../../components/VenueChip';
import { coverageLabel, windowValue } from './labels';

/** A window's figure; only an eligible one is coloured, so stale evidence never reads as a live ranking. */
function Rate({ row, days }: { row: BoardRow; days: number }) {
  const w = row.windows.find((x) => x.days === days);
  const { text, known } = windowValue(w);
  const n = Number(w?.netAnnualized);
  const tone = !known ? 'text-amber-300/90' : !w?.eligible ? 'text-ink-500' : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-ink-300';
  return <span className={`num ${tone}`}>{text}</span>;
}

function Status({ row, days }: { row: BoardRow; days: number }) {
  const selected = row.windows.find((w) => w.days === days);
  // Complete history that is not ranked can only be out of date; otherwise the coverage says why.
  const label = row.rank !== null ? 'Ranked' : !selected ? 'UNKNOWN' : selected.coverage === 'complete' ? 'STALE' : coverageLabel(selected.coverage);
  return (
    <span className="flex flex-col gap-0.5 text-[11px]">
      <span className={row.rank !== null ? 'text-ink-300' : 'text-amber-300/90'}>{label}</span>
      {row.executionBlockers.length > 0 && <span className="text-ink-400">Observe only</span>}
      {row.current?.reversed && <span className="text-amber-300/90">Current reversed</span>}
    </span>
  );
}

/** Every directed pair of the page, in the server's global order; a row picks the detail, never an order. */
export function CandidateTable({ board, selectedId, onSelect }: { board: FundingBoard; selectedId: string | null; onSelect: (id: string) => void }) {
  const compare = board.compareDays !== board.days;
  return (
    <table aria-label="Directed funding pairs" className="w-full text-[12px]">
      <thead className="text-left text-[11px] text-ink-400">
        <tr>
          <th className="px-2 py-1.5"># / Coin</th>
          <th className="px-2 py-1.5">Short → Long</th>
          <th className="px-2 py-1.5 text-right">{board.days}d APR</th>
          {compare && <th className="px-2 py-1.5 text-right">{board.compareDays}d APR</th>}
          <th className="px-2 py-1.5">Status</th>
        </tr>
      </thead>
      <tbody>
        {board.rows.map((row) => (
          <tr key={row.id} className={`border-t border-ink-800 ${row.id === selectedId ? 'bg-ink-800/60' : ''}`}>
            <td className="px-2 py-1.5">
              <span className="num mr-2 text-ink-400">{row.rank ?? '—'}</span>
              <span className="num text-ink-50">{row.underlying}</span>
            </td>
            <td className="px-2 py-1.5">
              <button type="button" className="flex flex-col items-start text-left" aria-pressed={row.id === selectedId} onClick={() => onSelect(row.id)}>
                <span className="inline-flex items-center gap-1.5">
                  <VenueChip exchange={row.short.venue} /> <span className="text-ink-500">→</span> <VenueChip exchange={row.long.venue} />
                </span>
                <span className="num text-[11px] text-ink-400">{row.short.contractId} / {row.long.contractId}</span>
              </button>
            </td>
            <td className="px-2 py-1.5 text-right"><Rate row={row} days={board.days} /></td>
            {compare && <td className="px-2 py-1.5 text-right"><Rate row={row} days={board.compareDays} /></td>}
            <td className="px-2 py-1.5"><Status row={row} days={board.days} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
