import { useId, useMemo, useState } from 'react';
import { readEvidence } from '../api/client';
import { useFundingSpreads } from '../api/queries';
import type { FundingFeedStatus, FundingQuote, FundingSpreadRow } from '../api/fundingSpreads';
import { Chip } from '../components/Chip';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';
import { TableSkeleton } from '../components/Skeleton';
import { VenueChip } from '../components/VenueChip';
import { fmtPct, fmtTime, sig, signedClass, toDate } from '../lib/fmt';

const microLabel = 'text-[11px] text-ink-400';

function Leg({ q }: { q: FundingQuote }) {
  return (
    <span className="inline-flex items-center gap-2">
      <VenueChip exchange={q.venue} />
      <span className={`num ${signedClass(q.apr)}`}>{fmtPct(q.apr, 1)}</span>
    </span>
  );
}

function Flags({ r }: { r: FundingSpreadRow }) {
  const unquoted = r.unquotedVenues.length > 0 && (
    <Chip sm tone="amber" title={`Listed on ${r.unquotedVenues.join(', ')} with no known rate — the best pair may be there.`}>
      {r.unquotedVenues.length} unquoted
    </Chip>
  );
  const price = r.priceMismatch ? (
    <Chip sm tone="red" title="The two legs' per-coin prices differ by more than 5% — probably two different tokens under one ticker.">
      Price mismatch
    </Chip>
  ) : r.priceUnchecked ? (
    <Chip sm tone="amber" title="A leg's feed carries no price, so the same-asset check could not run.">
      Price unchecked
    </Chip>
  ) : null;
  if (!unquoted && !price) return <span className="text-ink-600">—</span>;
  return (
    <span className="inline-flex gap-1.5">
      {price}
      {unquoted}
    </span>
  );
}

function feedNote(f: FundingFeedStatus): string {
  if (f.error === 'no-feed') return `${f.venue}: no public funding feed — left out`;
  if (f.error === 'empty') return `${f.venue} funding feed returned nothing — left out`;
  return `${f.venue} funding unavailable — left out`;
}

const COLUMNS: Column<FundingSpreadRow>[] = [
  { key: 'coin', header: 'Coin', render: (r) => <span className="num text-ink-50">{r.underlying}</span> },
  { key: 'short', header: 'Short (receives)', render: (r) => <Leg q={r.short} /> },
  { key: 'long', header: 'Long (pays)', render: (r) => <Leg q={r.long} /> },
  {
    key: 'spread',
    header: 'Spread APR',
    align: 'right',
    render: (r) => <span className="num font-semibold text-emerald-400">{fmtPct(r.spreadApr, 1)}</span>,
  },
  {
    key: 'payback',
    header: 'Payback',
    align: 'right',
    render: (r) => (
      <span className="num" title={r.roundTripFeeRate === null ? 'Fees unknown' : `Round-trip taker fees ${fmtPct(r.roundTripFeeRate, 3)}`}>
        {r.paybackDays === null ? '—' : `${sig(r.paybackDays, 1)} d`}
      </span>
    ),
  },
  { key: 'venues', header: 'Venues', align: 'right', render: (r) => <span className="num">{r.venues.length}</span> },
  { key: 'flags', header: '', render: (r) => <Flags r={r} /> },
];

const VENUE_COLUMNS: Column<FundingQuote>[] = [
  { key: 'symbol', header: 'Symbol', render: (q) => <span className="num text-[12px] text-ink-50">{q.symbol}</span> },
  { key: 'rate', header: 'Rate / interval', align: 'right', render: (q) => <span className="num">{fmtPct(q.rate, 4)} / {q.intervalHours}h</span> },
  { key: 'apr', header: 'APR', align: 'right', render: (q) => <span className={`num ${signedClass(q.apr)}`}>{fmtPct(q.apr, 1)}</span> },
  { key: 'price', header: 'Price / coin', align: 'right', render: (q) => <span className="num">{q.unitPrice === null ? '—' : sig(q.unitPrice, 8)}</span> },
  { key: 'next', header: 'Next funding', align: 'right', render: (q) => <span className="num">{q.nextFundingTime ? fmtTime(toDate(q.nextFundingTime)) : '—'}</span> },
];

/**
 * Funding Spreads tab: perp-vs-perp funding across every CrossEx venue, every
 * coin — no Boros leg. Read-only; the spread is the venues' CURRENT rates, so
 * it floats and can flip.
 */
export function FundingSpreadsPanel() {
  const { data, isPending, isError, error } = useFundingSpreads();
  const [search, setSearch] = useState('');
  const [maxPaybackText, setMaxPaybackText] = useState('7');
  const [hideMismatch, setHideMismatch] = useState(true);
  const paybackId = useId();

  const maxPayback = maxPaybackText.trim() === '' ? null : Number(maxPaybackText);
  const paybackBad = maxPayback !== null && !(Number.isFinite(maxPayback) && maxPayback > 0);

  const rows = useMemo(() => {
    const needle = search.trim().toUpperCase();
    return (data?.rows ?? []).filter(
      (r) =>
        (!needle || r.underlying.includes(needle)) &&
        !(hideMismatch && r.priceMismatch) &&
        // Unknown fees can't be judged against the window, so they stay visible;
        // a zero spread (null payback with known fees) never pays back.
        (maxPayback === null ||
          paybackBad ||
          (r.paybackDays !== null ? r.paybackDays <= maxPayback : r.roundTripFeeRate === null)),
    );
  }, [data, search, hideMismatch, maxPayback, paybackBad]);

  if (isPending) return <TableSkeleton rows={8} cols={7} />;
  if (isError && !data) return <QueryError title="Couldn't load funding spreads" error={error} />;

  const failed = (data?.feeds ?? []).filter((f) => !f.ok);
  const staleFeeds = (data?.feeds ?? []).filter((f) => f.ok && f.stale);
  const evidence = readEvidence(data);

  return (
    <section aria-label="Funding spreads">
      <h2 className="mb-1 text-[14px] font-semibold text-ink-50">
        Perp funding spreads <span className="normal-case text-ink-500">— short the venue paying most, long the one paying least</span>
      </h2>
      <p className="mb-3 text-[12px] text-ink-400">
        Current rates, annualised. Nothing here is locked: the spread floats and can flip. Payback is round-trip taker fees on both legs divided by
        the current daily spread; slippage, liquidity and transfer costs are not included.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search coin"
          aria-label="Search coin"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input h-[26px] w-36 !px-2 !py-0 text-[11px]"
        />
        <span className="flex items-center gap-1.5">
          <label htmlFor={paybackId} className={microLabel}>
            Payback within
          </label>
          <input
            id={paybackId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="any"
            value={maxPaybackText}
            onChange={(e) => setMaxPaybackText(e.target.value)}
            aria-invalid={paybackBad}
            className={`input num h-[26px] w-14 !px-2 !py-0 text-[11px] ${paybackBad ? 'border-rose-500/60' : ''}`}
          />
          <span className={microLabel}>days</span>
        </span>
        <label className={`flex items-center gap-1.5 ${microLabel}`}>
          <input type="checkbox" className="chk" checked={hideMismatch} onChange={(e) => setHideMismatch(e.target.checked)} />
          Hide price mismatches
        </label>
        <span className={`ml-auto ${microLabel}`}>
          {rows.length} of {data?.rows.length ?? 0} coins
          {evidence?.observedAt !== undefined && <> · as of {fmtTime(toDate(evidence.observedAt))}</>}
        </span>
      </div>
      {(failed.length > 0 || staleFeeds.length > 0 || evidence?.stale || data?.assumedFeeTier) && (
        <div className="mb-3 flex flex-wrap gap-2">
          {failed.map((f) => (
            <Chip key={f.venue} sm tone="red" title={`Feed status: ${f.error ?? 'unknown'}`}>
              {feedNote(f)}
            </Chip>
          ))}
          {staleFeeds.map((f) => (
            <Chip key={f.venue} sm tone="amber" title="Served from cache while the venue rate-limits us.">
              {f.venue} rates stale
            </Chip>
          ))}
          {evidence?.stale && staleFeeds.length === 0 && (
            <Chip sm tone="amber" title="The CrossEx listing or fee schedule was served from cache past its refresh time.">
              Listings or fees stale
            </Chip>
          )}
          {data?.assumedFeeTier && (
            <Chip sm tone="amber" title="Connect Gate keys to price payback from your own fee schedule.">
              Payback assumes {data.assumedFeeTier.toUpperCase()} fees
            </Chip>
          )}
        </div>
      )}
      <DataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.underlying}
        emptyState={<EmptyState icon="％" title="No spreads match" hint="Widen the payback window or clear the search." />}
        renderExpanded={(r) => (
          <div>
            <DataTable columns={VENUE_COLUMNS} rows={r.venues} rowKey={(q) => q.symbol} maxHeightClass="max-h-64" />
            {r.unquotedVenues.length > 0 && (
              <div className="mt-2 text-[12px] text-amber-300/90">
                Also listed on {r.unquotedVenues.join(', ')} — rate unknown there.
              </div>
            )}
          </div>
        )}
      />
    </section>
  );
}
