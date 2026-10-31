import { useState } from 'react';
import { useFundingSettlements, type SettlementParams, type SettlementWindow } from '../../api/fundingSettlements';
import { QueryError } from '../../components/QueryError';
import { TableSkeleton } from '../../components/Skeleton';
import { VenueChip } from '../../components/VenueChip';
import { fmtTime, toDate } from '../../lib/fmt';
import { micro, pct, reasonText } from './labels';

const DAYS = [7, 30, 90, 180, 365];

function Metric({ window, cumulative }: { window: SettlementWindow; cumulative: boolean }) {
  const value = cumulative ? window.total ?? window.observed?.total : window.annualized ?? window.observed?.annualized;
  const unverified = window.coverage !== 'complete';
  return <td className="px-2.5 py-2 text-right align-top" title={window.reasons.map((reason) => reasonText(reason)).join('; ')}>
    <span className={`num ${value == null ? 'text-ink-500' : !window.fresh ? 'text-warning' : 'text-ink-100'}`}>{value == null ? '—' : pct(value)}</span>
    <span className={`block whitespace-nowrap text-[10px] ${value == null ? 'text-ink-500' : 'text-ink-400'}`}>
      {value == null ? 'Not collected' : `${window.observed?.events ?? 0} settlements${window.cadence?.basis === 'inferred'
        ? ` · Inferred ${window.cadence.intervals.map((hours) => `${hours}h`).join('/')}` : ''}${unverified ? ' · Unverified' : ''}${!window.fresh && !window.restored ? ' · Stale' : ''}`}
    </span>
    <span className={`block text-[10px] ${window.fresh ? 'text-ink-400' : 'text-warning'}`}>
      {window.fresh ? 'Fresh' : window.restored ? '重启前数据，待核验' : window.verifiedAt ? 'Stale' : 'Not verified'}
    </span>
    {window.cutoff !== null && <span className={`block whitespace-nowrap ${micro}`}>Cutoff {fmtTime(toDate(window.cutoff))}</span>}
    {window.verifiedAt !== null && <span className={`block whitespace-nowrap ${micro}`}>Verified {fmtTime(toDate(window.verifiedAt))}</span>}
    {window.lastAttempt && <span className={`block whitespace-nowrap ${micro}`}>Last try {fmtTime(toDate(window.lastAttempt.at))}</span>}
    {window.reasons.length > 0 && <span className="block max-w-56 text-[10px] text-warning">
      {window.reasons.map((reason) => reasonText(reason)).join('; ')}
    </span>}
  </td>;
}

/** Native-venue observations do not need, and never imply, cross-venue eligibility. */
export function VenueSettlementHistory() {
  const [params, setParams] = useState<SettlementParams>({ venue: '', asset: '', offset: 0 });
  const [cumulative, setCumulative] = useState(false);
  const { data, isPending, isError, error, isFetching } = useFundingSettlements(params);
  const filter = (change: Partial<SettlementParams>) => setParams((old) => ({ ...old, ...change, offset: 0 }));
  return <section aria-label="Venue settlement history" className="mb-5 rounded border border-ink-800 p-3">
    <h3 className="text-[13px] font-semibold text-ink-100">Venue settlement history</h3>
    <p className={`mt-1 ${micro}`}>
      Actual returned settlements, including contracts without a comparable peer. Unverified means completeness is not proven;
      these observations are not ranked and cannot enable an open. APR is the returned total × 365 ÷ window days.
    </p>
    <div className={`my-3 flex flex-wrap items-center gap-3 ${micro}`}>
      <label>History venue <select aria-label="History venue" className="ml-1 rounded border border-ink-700 bg-ink-900 px-2 py-1"
        value={params.venue} onChange={(event) => filter({ venue: event.target.value })}>
        <option value="">All venues</option>
        {data?.options.venues.map((venue) => <option key={venue}>{venue}</option>)}
      </select></label>
      <label>Native asset code <select aria-label="Native asset code" className="ml-1 rounded border border-ink-700 bg-ink-900 px-2 py-1"
        value={params.asset} onChange={(event) => filter({ asset: event.target.value })}>
        <option value="">All assets</option>
        {data?.options.underlyings.map((asset) => <option key={asset}>{asset}</option>)}
      </select></label>
      <label className="inline-flex items-center gap-1"><input type="checkbox" checked={cumulative}
        onChange={(event) => setCumulative(event.target.checked)} />Cumulative totals</label>
      {isFetching && !isPending && <span>Updating…</span>}
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
            <td className="px-2.5 py-2 align-top"><span className="inline-flex items-center gap-2"><VenueChip exchange={row.venue} />
              <span className="num text-ink-100">{row.contractId}</span></span>
              <span className={`mt-0.5 block ${micro}`}>{cutoff ? `Cutoff ${fmtTime(toDate(cutoff))}`
                : row.lastAttempt?.reason ? reasonText(row.lastAttempt.reason) : 'Waiting for history collection'}</span>
              {row.lastAttempt && <span className={`block ${micro}`}>Last try {fmtTime(toDate(row.lastAttempt.at))}
                {row.lastAttempt.reason ? ` · ${reasonText(row.lastAttempt.reason)}` : ''}</span>}
              {row.backfill && <span className={`block ${micro}`}>Read through {row.backfill.completeThroughDays}d
                {row.backfill.pendingDays !== null ? ` · Next ${row.backfill.pendingDays}d` : ' · Backfill complete'}
                {` · ${row.backfill.pagesRead} batches saved`}</span>}
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
  </section>;
}
