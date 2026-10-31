import type { BoardRow, FundingBoard } from '../../api/fundingOpportunities';
import { VenueChip } from '../../components/VenueChip';
import { coverageLabel, decimalSign, windowValue } from './labels';

/** A window's figure; only an eligible one is coloured, so stale evidence never reads as a live ranking. */
function Rate({ row, days }: { row: BoardRow; days: number }) {
  const w = row.windows.find((x) => x.days === days);
  const { text, known } = windowValue(w);
  const sign = decimalSign(w?.netAnnualized);
  const tone = !known ? 'text-warning' : !w?.eligible ? 'text-ink-500' : sign === 1 ? 'text-grass' : sign === -1 ? 'text-guava' : 'text-ink-300';
  return <span className={`num ${tone}`}>{text}</span>;
}

function Status({ row, days }: { row: BoardRow; days: number }) {
  const selected = row.windows.find((w) => w.days === days);
  // Complete history that is not ranked can only be out of date; otherwise the coverage says why.
  const label = row.rank !== null ? 'Ranked' : !selected ? 'UNKNOWN' : selected.coverage === 'complete' ? 'STALE' : coverageLabel(selected.coverage);
  return (
    <span className="flex flex-col gap-0.5 text-[11px]">
      <span className={row.rank !== null ? 'text-ink-300' : 'text-warning'}>{label}</span>
      {row.executionBlockers.length > 0 && <span className="text-ink-400">Observe only</span>}
      {row.current?.reversed && <span className="text-warning">Current reversed</span>}
    </span>
  );
}

/** Every directed pair of the page, in the server's global order; a row picks the detail, never an order. */
export function CandidateTable({ board, selectedId, onSelect }: { board: FundingBoard; selectedId: string | null; onSelect: (id: string) => void }) {
  const compare = board.compareDays !== board.days;
  return (
    <table aria-label="Directed funding pairs" className="w-full text-[12px]">
      <thead>
        <tr>
          <th className="th text-left"># / Coin</th>
          <th className="th text-left">Short → Long</th>
          <th className="th text-right">{board.days}d APR</th>
          {compare && <th className="th text-right">{board.compareDays}d APR</th>}
          <th className="th text-left">Status</th>
        </tr>
      </thead>
      <tbody>
        {board.rows.map((row) => (
          // The whole row selects; the leg button is its keyboard target, and its click bubbles here.
          <tr key={row.id} onClick={() => onSelect(row.id)}
            className={`cursor-pointer border-t border-ink-850 ${row.id === selectedId ? 'bg-ink-800' : 'hover:bg-ink-800/50'}`}>
            <td className="px-2.5 py-1.5">
              <span className="num mr-2 text-ink-400">{row.rank ?? '—'}</span>
              <span className="num text-ink-50">{row.underlying}</span>
            </td>
            <td className="px-2.5 py-1.5">
              <button type="button" className="flex flex-col items-start text-left" aria-pressed={row.id === selectedId}>
                <span className="inline-flex items-center gap-1.5">
                  <VenueChip exchange={row.short.venue} /> <span className="text-ink-500">→</span> <VenueChip exchange={row.long.venue} />
                </span>
                <span className="num text-[11px] text-ink-400">{row.short.contractId} / {row.long.contractId}</span>
              </button>
            </td>
            <td className="px-2.5 py-1.5 text-right"><Rate row={row} days={board.days} /></td>
            {compare && <td className="px-2.5 py-1.5 text-right"><Rate row={row} days={board.compareDays} /></td>}
            <td className="px-2.5 py-1.5"><Status row={row} days={board.days} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
