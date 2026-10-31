import type { FundingBoard } from '../../api/fundingOpportunities';
import { Chip } from '../../components/Chip';

const STOPPED: Record<string, string> = { 'budget-exhausted': 'collection allowance used', 'rate-limited': 'venue rate limit' };

/** History gaps behind the shown rows, as status chips; the detail sits in each chip's tooltip. */
export function HistoryDiagnostics({ board }: { board: FundingBoard }) {
  const observed = board.rows.filter((row) => {
    const window = row.windows.find((w) => w.days === board.days);
    return window?.netAnnualized === null && window.observed;
  }).length;
  const venues = new Set(board.rows.flatMap((row) => [row.short.venue, row.long.venue]));
  const paused = Object.entries(board.history.lastRound?.venues ?? {}).filter(([venue, report]) => venues.has(venue) && report.stopped);
  return <>
    {observed > 0 && <Chip sm tone="amber" title="Their spreads use returned settlements whose completeness is not proven yet. Status names the missing evidence.">
      {observed} pairs observed only
    </Chip>}
    {paused.length > 0 && <Chip sm title={`History collection\n${paused.map(([venue, report]) => `${venue}\t${STOPPED[report.stopped!] ?? report.stopped}`).join('\n')}
* Pending histories retry in a later round; completed windows remain visible.`}>
      History collection paused · {paused.map(([venue]) => venue).join(', ')}
    </Chip>}
  </>;
}
