import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useFundingSettlements, type SettlementParams, type SettlementWindow } from '../../api/fundingSettlements';
import { QueryError } from '../../components/QueryError';
import { TableSkeleton } from '../../components/Skeleton';
import { TipLabel } from '../../components/Th';
import { VenueChip } from '../../components/VenueChip';
import { fmtTime, toDate } from '../../lib/fmt';
import { readJson, writeJson } from '../../lib/storage';
import { micro, pct, reasonText } from './labels';

const DAYS = [7, 30, 90, 180, 365];

const time = (ms: number) => fmtTime(toDate(ms));

/** One window: the figure and a single status line; the evidence behind it sits in the tooltip. */
function Metric({ window, cumulative }: { window: SettlementWindow; cumulative: boolean }) {
  const value = cumulative ? window.total ?? window.observed?.total : window.annualized ?? window.observed?.annualized;
  const unverified = window.coverage !== 'complete';
  const freshness = window.fresh ? 'Fresh' : window.restored ? '重启前数据，待核验' : window.verifiedAt ? 'Stale' : 'Not verified';
  const warn = !window.fresh || window.reasons.length > 0;
  const tip = [
    `${window.days}d window`,
    `Settlements\t${window.observed?.events ?? 0}`,
    ...(window.cadence ? [`Cadence\t${window.cadence.basis === 'inferred' ? 'Inferred ' : ''}${window.cadence.intervals.map((h) => `${h}h`).join('/')}`] : []),
    `Coverage\t${unverified ? 'Unverified' : 'Complete'}`,
    ...(window.cutoff !== null ? [`Cutoff\t${time(window.cutoff)}`] : []),
    ...(window.verifiedAt !== null ? [`Verified\t${time(window.verifiedAt)}`] : []),
    ...(window.lastAttempt ? [`Last try\t${time(window.lastAttempt.at)}`] : []),
    ...(window.reasons.length ? ['---', `* ${window.reasons.map((reason) => reasonText(reason)).join('; ')}`] : []),
  ].join('\n');
  return <td className="px-2.5 py-2 text-right align-top" title={value == null ? window.reasons.map((reason) => reasonText(reason)).join('; ') || undefined : tip}>
    <span className={`num block ${value == null ? 'text-ink-500' : !window.fresh ? 'text-warning' : 'text-ink-100'}`}>{value == null ? '—' : pct(value)}</span>
    <span className={`block whitespace-nowrap text-[11px] ${value == null ? 'text-ink-500' : warn ? 'text-warning' : 'text-ink-400'}`}>
      {value == null ? 'Not collected' : `${freshness}${unverified ? ' · Unverified' : ''}`}
    </span>
  </td>;
}

const OPEN_KEY = 'funding.venueHistoryOpen';

/** Native-venue observations do not need, and never imply, cross-venue eligibility. */
export function VenueSettlementHistory({ initialOpen }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(() => initialOpen ?? readJson(OPEN_KEY, false, (v) => v === true));
  const toggle = () => setOpen((was) => {
    writeJson(OPEN_KEY, !was);
    return !was;
  });
  return <section aria-label="Venue settlement history" className="mt-6 border-t border-ink-800 pt-4">
    <div className="flex items-center gap-3">
      <button type="button" aria-expanded={open} onClick={toggle}
        className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-100 hover:text-ink-50">
        <ChevronRight size={14} aria-hidden className={`text-ink-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        Venue settlement history
      </button>
      <TipLabel className="text-[12px] text-ink-400" title={HISTORY_TIP}>Observed per venue, not ranked</TipLabel>
    </div>
    {open && <SettlementTable />}
  </section>;
}

const HISTORY_TIP = `Venue settlement history
Actual returned settlements, including contracts without a comparable peer. APR is the returned total × 365 ÷ window days.
* Unverified means completeness is not proven; these observations are not ranked and cannot enable an open.`;

function SettlementTable() {
  const [params, setParams] = useState<SettlementParams>({ venue: '', asset: '', offset: 0 });
  const [cumulative, setCumulative] = useState(false);
  const { data, isPending, isError, error, isFetching } = useFundingSettlements(params);
  const filter = (change: Partial<SettlementParams>) => setParams((old) => ({ ...old, ...change, offset: 0 }));
  return <div className="mt-3">
    <div className="mb-3 flex flex-wrap items-center gap-4 text-[12px] text-ink-300">
      <label className="flex items-center gap-1.5">Venue <select aria-label="History venue" className="input h-[28px] !py-0 text-[12px]"
        value={params.venue} onChange={(event) => filter({ venue: event.target.value })}>
        <option value="">All venues</option>
        {data?.options.venues.map((venue) => <option key={venue}>{venue}</option>)}
      </select></label>
      <label className="flex items-center gap-1.5">Asset <select aria-label="Native asset code" className="input h-[28px] !py-0 text-[12px]"
        value={params.asset} onChange={(event) => filter({ asset: event.target.value })}>
        <option value="">All assets</option>
        {data?.options.underlyings.map((asset) => <option key={asset}>{asset}</option>)}
      </select></label>
      <label className="flex cursor-pointer items-center gap-1.5 text-ink-200"><input type="checkbox" className="chk" checked={cumulative}
        onChange={(event) => setCumulative(event.target.checked)} />Cumulative totals</label>
      {isFetching && !isPending && <span className="text-ink-400">Updating…</span>}
    </div>
    {isPending && <TableSkeleton rows={3} cols={6} />}
    {isError && <QueryError title="Couldn't load venue settlement history" error={error} />}
    {data && <>
      <div className="max-h-80 overflow-auto"><table aria-label="Venue historical settlements" className="w-full text-[12px]">
        <thead className="sticky top-0 bg-ink-900"><tr><th className="th text-left">Venue / native contract</th>
          {DAYS.map((days) => <th key={days} className="th whitespace-nowrap text-right">{days}d {cumulative ? 'total' : 'observed APR'}</th>)}
        </tr></thead>
        <tbody>{data.rows.map((row) => {
          const cutoff = row.windows.find((window) => window.observed)?.cutoff;
          return <tr key={row.symbol} className="border-t border-ink-850">
            <td className="px-2.5 py-2 align-top" title={[
              `${row.venue} ${row.contractId}`,
              ...(cutoff ? [`Cutoff\t${time(cutoff)}`] : []),
              ...(row.lastAttempt ? [`Last try\t${time(row.lastAttempt.at)}`] : []),
              ...(row.backfill ? [`Read through\t${row.backfill.completeThroughDays}d`, `Batches saved\t${row.backfill.pagesRead}`] : []),
              ...(row.lastAttempt?.reason ? ['---', `* ${reasonText(row.lastAttempt.reason)}`] : []),
            ].join('\n')}>
              <span className="inline-flex items-center gap-2"><VenueChip exchange={row.venue} />
                <span className="num text-ink-100">{row.contractId}</span></span>
              {(row.backfill?.pendingDays != null || !cutoff) && <span className="mt-0.5 block text-[11px] text-ink-400">
                {row.backfill?.pendingDays != null ? `Backfill ${row.backfill.completeThroughDays}d → ${row.backfill.pendingDays}d`
                  : row.lastAttempt?.reason ? reasonText(row.lastAttempt.reason) : 'Waiting for collection'}
              </span>}
            </td>
            {row.windows.map((window) => <Metric key={window.days} window={window} cumulative={cumulative} />)}
          </tr>;
        })}</tbody>
      </table></div>
      {!data.rows.length && <p className={`py-3 ${micro}`}>No native contracts match this filter.</p>}
      <div className={`mt-2 flex items-center gap-3 ${micro}`}>
        <span>{data.matched} contracts · Page {Math.floor(data.offset / data.limit) + 1} of {Math.max(1, Math.ceil(data.matched / data.limit))}</span>
        <button type="button" className="btn-ghost-xs" aria-label="Previous history page" disabled={data.offset === 0 || isFetching}
          onClick={() => setParams((old) => ({ ...old, offset: Math.max(0, data.offset - data.limit) }))}>Previous</button>
        <button type="button" className="btn-ghost-xs" aria-label="Next history page" disabled={data.offset + data.limit >= data.matched || isFetching}
          onClick={() => setParams((old) => ({ ...old, offset: data.offset + data.limit }))}>Next</button>
      </div>
    </>}
  </div>;
}
