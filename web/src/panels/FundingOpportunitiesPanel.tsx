import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { HISTORY_DAYS, type HistoryDays } from '../../../src/core/funding/history';
import { useFundingOpportunities, type BoardParams, type FundingBoard } from '../api/fundingOpportunities';
import { Chip } from '../components/Chip';
import { QueryError } from '../components/QueryError';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { TableSkeleton } from '../components/Skeleton';
import { fmtTime, toDate } from '../lib/fmt';
import { CandidateDetail } from './funding/CandidateDetail';
import { CandidateTable } from './funding/CandidateTable';
import { dealSummary } from './funding/FundingReceiptView';
import { FundingSubmissionsProvider, useFundingSubmissions } from './funding/FundingSubmissions';
import { micro, UNPAIRED } from './funding/labels';


/** Why the page shows less than a full market, in the server's own terms. */
function Notices({ board }: { board: FundingBoard }) {
  const { history, contracts } = board;
  const failedFeeds = board.feeds.filter((f) => !f.ok);
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {!board.admission?.open && <Chip sm tone="amber">Manual opening is not enabled — previews can only be observed.</Chip>}
      {contracts.state === 'unwired' && <Chip sm tone="amber">No proven contract mapping is wired yet — no candidates can be formed.</Chip>}
      {contracts.state === 'cold' && (
        <Chip sm tone="amber">
          {contracts.lastAttempt ? 'The contract list could not be read — no candidates yet.' : 'The contract list has not been read yet.'}
        </Chip>
      )}
      {contracts.lastAttempt?.ok === false && contracts.at !== null && (
        <Chip sm tone="amber">Contract list refresh failed — using the list read {fmtTime(toDate(contracts.at))}.</Chip>
      )}
      {history.state === 'cold' && <Chip sm tone="amber">No funding history has been published yet (cold start) — every row is UNKNOWN.</Chip>}
      {history.cutoffBehind && <Chip sm tone="amber">History is behind the current UTC hour — nothing ranks until it refreshes.</Chip>}
      {history.lastRound?.outcome === 'failed' && (
        <Chip sm tone="red">
          The last history refresh failed{history.publishedAt !== null ? ` — showing history published ${fmtTime(toDate(history.publishedAt))}` : ''}.
        </Chip>
      )}
      {failedFeeds.map((f) => (
        <Chip key={f.venue} sm tone="amber" title={`Feed status: ${f.error ?? 'unknown'}`}>
          {f.venue} current rate {f.error === 'no-feed' ? 'has no public feed' : 'unavailable'}
          {f.at !== null ? ` — last read ${fmtTime(toDate(f.at))}` : ''}
        </Chip>
      ))}
    </div>
  );
}

function Filters({ board, params, set }: { board: FundingBoard | undefined; params: BoardParams; set: (p: Partial<BoardParams>) => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <SegmentedToggle ariaLabel="History window" value={String(params.days)}
        options={HISTORY_DAYS.map((d) => ({ value: String(d), label: `${d}d` }))}
        onChange={(v) => set({ days: Number(v) as HistoryDays })} />
      <label className={`flex items-center gap-1.5 ${micro}`}>
        Coin
        <select className="input h-[26px] !py-0 text-[11px]" value={params.underlying ?? ''} onChange={(e) => set({ underlying: e.target.value || null })}>
          <option value="">All coins</option>
          {board?.options.underlyings.map((u) => <option key={u}>{u}</option>)}
        </select>
      </label>
      <label className={`flex items-center gap-1.5 ${micro}`}>
        Venue
        <select className="input h-[26px] !py-0 text-[11px]" value={params.venue ?? ''} onChange={(e) => set({ venue: e.target.value || null })}>
          <option value="">Any venue</option>
          {board?.options.venues.map((v) => <option key={v}>{v}</option>)}
        </select>
      </label>
      <label className={`flex items-center gap-1.5 ${micro}`}>
        <input type="checkbox" className="chk" checked={params.positive} onChange={(e) => set({ positive: e.target.checked })} />
        Positive spread only
      </label>
    </div>
  );
}

/** Every intent this page has sent, whichever pair is selected. */
function SentIntents() {
  const { all } = useFundingSubmissions();
  if (!all.length) return null;
  return (
    <ul aria-label="Sent intents" className={`mb-3 ${micro}`}>
      {all.map(({ record, state }) => (
        <li key={record.body.intentId} className="num">
          {record.body.intentId} · {candidateLabel(record.candidateId)} ·{' '}
          {state.kind === 'accepted' ? dealSummary(state.receipt) : 'result not known yet'}
        </li>
      ))}
    </ul>
  );
}

/** "BTC short BINANCE BTCUSDT → long BYBIT BTCUSDT" from a candidate id, or the id itself. */
function candidateLabel(id: string): string {
  try {
    const [u, sv, sc, lv, lc] = JSON.parse(id) as string[];
    return `${u} short ${sv} ${sc} → long ${lv} ${lc}`;
  } catch {
    return id;
  }
}

/**
 * Funding Spreads tab (ticket 18): every directed perp-vs-perp pair ranked by
 * settled funding history, with the selected pair's evidence alongside.
 * Opening goes only through the selected pair's preview and the server's
 * admission (tickets 12/13); sent intents are restored and resolved by id (ticket 14).
 */
export function FundingOpportunitiesPanel() {
  return (
    <FundingSubmissionsProvider>
      <Board />
    </FundingSubmissionsProvider>
  );
}

function Board() {
  const [params, setParams] = useState<BoardParams>({ days: 30, underlying: null, venue: null, positive: false, offset: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const { data, isPending, isError, error } = useFundingOpportunities(params);

  // The server answered page one of a new ranking: follow it, and say so.
  useEffect(() => {
    if (!data?.rankingChanged) return;
    setChanged(true);
    setParams((p) => ({ ...p, offset: 0, rankingId: undefined }));
  }, [data]);

  const filter = (next: Partial<BoardParams>) => {
    setChanged(false);
    setParams((p) => ({ ...p, ...next, offset: 0, rankingId: undefined }));
  };
  const page = (offset: number) => {
    setChanged(false);
    setParams((p) => ({ ...p, offset, rankingId: data?.rankingId }));
  };

  const selected = data?.rows.find((r) => r.id === selectedId) ?? data?.rows[0];
  const pages = data ? Math.max(1, Math.ceil(data.matched / data.limit)) : 1;
  const current = data ? Math.floor(data.offset / data.limit) + 1 : 1;

  return (
    <section aria-label="Funding opportunities">
      <h2 className="mb-1 text-[14px] font-semibold text-ink-50">
        Perp funding opportunities <span className="text-ink-500">— every directed pair, ranked by settled history</span>
      </h2>
      <p className="mb-3 text-[12px] text-ink-400">
        Short leg minus long leg, settled funding only, annualised. Zero, negative and UNKNOWN pairs stay listed; UNKNOWN is never scored as
        zero. History-eligible is not permission to open, and no costs are included.
      </p>
      <SentIntents />
      <Filters board={data} params={params} set={filter} />
      {isPending && <TableSkeleton rows={8} cols={5} />}
      {isError && !data && <QueryError title="Couldn't load funding opportunities" error={error} />}
      {data && (
        <>
          <Notices board={data} />
          {changed && <p className="mb-2 text-[12px] text-warning">The ranking changed while you were paging — showing page 1 of the new ranking.</p>}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div>
              {data.rows.length ? (
                <CandidateTable board={data} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
              ) : (
                <p className="py-6 text-center text-[12px] text-ink-400">No candidates match — missing data is not counted as zero.</p>
              )}
              <div className={`mt-2 flex items-center gap-3 ${micro}`}>
                <span>
                  {data.matched} of {data.candidateCount} pairs · {data.rankedCount} ranked · as of {fmtTime(toDate(data.evaluatedAt))}
                </span>
                <span className="ml-auto" />
                <button type="button" className="btn-ghost-xs" aria-label="Previous page" disabled={data.offset === 0}
                  onClick={() => page(Math.max(0, data.offset - data.limit))}>
                  <ChevronLeft size={14} aria-hidden />
                </button>
                <span>Page {current} of {pages}</span>
                <button type="button" className="btn-ghost-xs" aria-label="Next page" disabled={current >= pages} onClick={() => page(data.offset + data.limit)}>
                  <ChevronRight size={14} aria-hidden />
                </button>
              </div>
              {!!data.contracts.rejected?.length && (
                <details className="mt-2 text-warning">
                  <summary>{data.contracts.rejected.length} CrossEx contracts could not be mapped</summary>
                  <ul className="mt-1">
                    {data.contracts.rejected.map((r, i) => <li key={`${r.symbol}/${i}`}>{r.symbol}: {r.reason}</li>)}
                  </ul>
                </details>
              )}
              {data.contracts.unpaired.length > 0 && (
                <details className={`mt-3 ${micro}`}>
                  <summary>{data.contracts.unpaired.length} contracts not paired</summary>
                  <ul className="mt-1">
                    {data.contracts.unpaired.map((u) => <li key={`${u.venue}/${u.contractId}`}>{u.venue} {u.contractId}: {UNPAIRED[u.reason] ?? u.reason}</li>)}
                  </ul>
                </details>
              )}
            </div>
            {selected && (
              <CandidateDetail row={selected} days={data.days} snapshotId={data.snapshotId} admissionOpen={!!data.admission?.open} />
            )}
          </div>
        </>
      )}
    </section>
  );
}
