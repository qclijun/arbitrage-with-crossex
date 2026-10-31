import type { FundingBoard } from '../../api/fundingOpportunities';

export function HistoryDiagnostics({ board }: { board: FundingBoard }) {
  const observed = board.rows.filter((row) => {
    const window = row.windows.find((w) => w.days === board.days);
    return window?.netAnnualized === null && window.observed;
  }).length;
  const venues = new Set(board.rows.flatMap((row) => [row.short.venue, row.long.venue]));
  const paused = Object.entries(board.history.lastRound?.venues ?? {}).filter(([venue, report]) => venues.has(venue) && report.stopped);
  return <div aria-label="History diagnostics" className="mb-2 text-[12px] text-ink-400">
    {observed > 0 && <p>{observed} shown pairs have observed spreads but still need completeness checks. See Status for the missing evidence.</p>}
    {paused.length > 0 && <p>History collection: {paused.map(([venue, report]) => `${venue}: ${report.stopped === 'budget-exhausted'
      ? 'collection allowance used' : report.stopped === 'rate-limited' ? 'venue rate limit' : report.stopped}`).join('; ')}.
      {' '}Pending histories retry in a later round; completed windows remain visible.</p>}
  </div>;
}
