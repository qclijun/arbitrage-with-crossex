import { useRef, useState } from 'react';
import type { Evidence } from '../../../src/core/boros/liquidity';
import type { Metric } from '../../../src/core/boros/liquidity-metrics';
import type { LiquidityMarket } from '../api/borosLiquidity';
import { useBorosLiquidity } from '../api/queries';

// Mirrors the public snapshot TTLs in src/server/cache.ts. Each input keeps its own clock.
const MARKET_TTL_MS = 30_000;
const BOOK_TTL_MS = 90_000;
const time = (value: number | null) => value === null ? 'UNKNOWN' : new Date(value).toISOString();
const apr = (value: unknown) => typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : 'UNKNOWN';
const quantity = (value: unknown) => value === null ? 'UNKNOWN' : String(value);

function status(evidence: Evidence<unknown>, ttl: number, failed: boolean) {
  return failed || evidence.freshness === 'stale' || (evidence.collectedAt !== null && Date.now() - evidence.collectedAt >= ttl)
    || (evidence.sourceObservedAt !== null && Date.now() - evidence.sourceObservedAt >= ttl) ? 'STALE' : evidence.freshness.toUpperCase();
}

function Provenance({ evidence, ttl, failed }: { evidence: Evidence<unknown>; ttl: number; failed: boolean }) {
  const expired = status(evidence, ttl, failed) === 'STALE';
  const inputs = 'inputs' in evidence ? (evidence as Metric<unknown>).inputs : [];
  return <details className="mt-1 break-all text-xs text-ink-400">
    <summary className="cursor-pointer">{expired ? 'STALE' : evidence.freshness.toUpperCase()} · {evidence.completeness} · evidence</summary>
    <p>Source: {evidence.source}</p><p>Source time: {time(evidence.sourceObservedAt)}</p>
    <p>Collected: {time(evidence.collectedAt)}</p>
    <p>Reasons: {[...evidence.reason, ...(expired ? ['STALE'] : []), ...(failed ? ['REQUEST_FAILED_RETAINED_SNAPSHOT'] : [])].join(', ') || 'none'}</p>
    {inputs.map((input, index) => <p key={index}>Input: {input.source} · source {time(input.sourceObservedAt)} · collected {time(input.collectedAt)} · {input.freshness} / {input.completeness} · {input.reason.join(', ')}</p>)}
  </details>;
}
function Measurement({ label, evidence, format = quantity, ttl = BOOK_TTL_MS, failed }: {
  label: string; evidence: Evidence<unknown>; format?: (value: unknown) => string; ttl?: number; failed: boolean;
}) {
  return <div className="min-w-0 rounded-lg bg-ink-950/40 p-3">
    <dt className="text-xs text-ink-400">{label}</dt><dd className="num mt-1 break-all text-sm text-ink-100">{format(evidence.value)}{evidence.value === null ? '' : ` ${evidence.unit === 'APR-fraction' ? '' : evidence.unit === 'APR-bp' ? 'APR bp' : evidence.unit}`}</dd>
    <Provenance evidence={evidence} ttl={ttl} failed={failed} />
  </div>;
}
function Depth({ depth, failed }: { depth: LiquidityMarket['metrics']['bids']['visibleDepth']; failed: boolean }) {
  return <dl className="grid gap-2 sm:grid-cols-3">
    <Measurement label="Visible quantity" evidence={depth.yu} failed={failed} />
    <Measurement label="Collateral nominal exposure" evidence={depth.collateralNotional} failed={failed} />
    <Measurement label="USD nominal exposure" evidence={depth.usdNotional} failed={failed} />
  </dl>;
}
function Diagnostics({ market, failed }: { market: LiquidityMarket; failed: boolean }) {
  const id = market.identity.value;
  const m = market.metrics;
  const raw = market.identity.raw as { state?: unknown } | null;
  return <section aria-label={`Market ${id?.marketId} diagnostics`} className="min-w-0 rounded-xl border border-ink-700 p-4">
    <h3 className="text-lg font-semibold">{id?.venue ?? 'UNKNOWN'} · {id?.symbol ?? 'UNKNOWN'} · Market {id?.marketId}</h3>
    <p className="mt-2 break-all text-xs text-ink-400">Collateral {market.collateral.value?.symbol ?? 'UNKNOWN'} · Maturity {time(id?.maturity ? id.maturity * 1000 : null)}</p>
    <p className="mt-1 text-xs text-ink-400">Market mode (metadata only): {typeof raw?.state === 'number' || typeof raw?.state === 'string' ? String(raw.state) : 'UNKNOWN'} · trading permissions unverified</p>
    <Provenance evidence={market.identity} ttl={MARKET_TTL_MS} failed={failed} />
    <Provenance evidence={market.collateral} ttl={MARKET_TTL_MS} failed={failed} />
    <p className="mt-3 text-xs text-ink-400">Aggregated order-book APR / Spread · bucket tick {m.bookTickSize * 10000} APR bp ({m.bookTickSize * 100} pp). APR display rounded to 2 decimal places.</p>
    <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Measurement label="24h Volume · rolling 24h" evidence={market.volume24hYu} ttl={MARKET_TTL_MS} failed={failed} />
      <Measurement label="Notional OI · one-sided" evidence={market.notionalOiOneSidedYu} ttl={MARKET_TTL_MS} failed={failed} />
      <Measurement label="Best bid APR" evidence={m.bestBidApr} format={apr} failed={failed} />
      <Measurement label="Best ask APR" evidence={m.bestAskApr} format={apr} failed={failed} />
      <Measurement label="Mid APR" evidence={m.midApr} format={apr} failed={failed} />
      <Measurement label="Spread · ask − bid" evidence={m.spreadAprBp} format={value => value === null ? 'UNKNOWN' : Number(value).toFixed(2)} failed={failed} />
    </dl>
    {m.crossed && <p className="mt-3 text-guava">CROSSED_BOOK · negative Spread retained</p>}
    <p className="mt-4 text-xs text-ink-400">Pure order book, AMM excluded; best 50 aggregated levels per side at most. Returned levels are visible depth, not full-book totals. 1 APR bp = 0.01 pp. Quantities are YU / collateral nominal exposure, not cash or margin.</p>
    <div className="mt-4 grid gap-5 lg:grid-cols-2">{(['bids', 'asks'] as const).map(side => <div key={side} className="min-w-0">
      <h4 className="mb-2 font-semibold">{side === 'bids' ? 'Bids · long' : 'Asks · short'}</h4>
      <dl className="mb-2 grid gap-2 sm:grid-cols-2"><Measurement label="Returned valid levels" evidence={m[side].levelCount} failed={failed} /><Measurement label="Farthest APR" evidence={m[side].farthestApr} format={apr} failed={failed} /></dl>
      <Depth depth={m[side].visibleDepth} failed={failed} />
      {m[side].windows.map(window => <div key={window.widthAprBp} className="mt-4">
        <p className="mb-2 text-xs text-ink-300">{window.widthAprBp} APR bp from this side’s best · [{apr(window.fromApr)}, {apr(window.toApr)}] inclusive · {window.coverage}</p>
        <Depth depth={window.depth} failed={failed} />
      </div>)}
    </div>)}</div>
  </section>;
}

export function BorosLiquidityPanel() {
  const query = useBorosLiquidity();
  const diagnostics = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const markets = query.data?.markets ?? [];
  const current = markets.find(m => m.marketKey === selected) ?? markets[0];
  const venues = [...new Set(markets.map(m => m.identity.value?.venue ?? 'UNKNOWN venue'))];
  return <section aria-label="Boros market liquidity" className="min-w-0 text-ink-100">
    <div className="mb-4 flex flex-wrap justify-between gap-3"><div><h2 className="text-xl font-semibold">Boros market liquidity</h2>
      <p className="mt-1 text-sm text-ink-400">Read-only market liquidity diagnostics. No atomic rollover readiness, guaranteed fills or margin conclusions.</p></div>
      <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()} className="rounded-lg border border-ink-700 px-3 py-2 text-sm disabled:opacity-40">Refresh</button>
    </div>
    <p className="mb-3 text-xs text-ink-400">Live, UI-whitelisted markets only; separate venue / collateral / maturity. Statistics and books have independent clocks. Diagnostic windows are not trading slippage settings. Refresh every 30 seconds while active, using server caches.</p>
    {query.isPending && <p role="status">Loading market liquidity…</p>}
    {query.isError && <p role="alert" className="mb-3 text-guava">UNKNOWN · request failed. {query.data ? 'Retained snapshot is STALE; values below are old data.' : 'No successful snapshot available.'}</p>}
    {query.data && <><p className="text-xs">Coverage: {query.data.coverage.value?.returnedMarkets ?? 'UNKNOWN'} markets · {query.data.coverage.value?.pages ?? 'UNKNOWN'} pages · chain {query.data.scope.chainId} · {query.data.scope.deployment}</p>
      <Provenance evidence={query.data.coverage} ttl={MARKET_TTL_MS} failed={query.isError} />
      {!markets.length && <p className="mt-4">No markets returned in this scope. Coverage evidence determines whether this is complete.</p>}
    </>}
    <div className="my-5 space-y-4">{venues.map(venue => <section key={venue} aria-label={`${venue} markets`}>
      <h3 className="mb-2 text-sm font-semibold text-info">{venue}</h3>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{markets.filter(m => (m.identity.value?.venue ?? 'UNKNOWN venue') === venue).map(m => <button key={m.marketKey} type="button" aria-pressed={current?.marketKey === m.marketKey} onClick={() => { setSelected(m.marketKey); diagnostics.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}
        className={`min-w-0 rounded-lg border p-3 text-left text-sm ${current?.marketKey === m.marketKey ? 'border-info bg-info/10' : 'border-ink-700 bg-ink-900/60'}`}>
        <span className="block break-all font-medium">{m.identity.value?.symbol ?? 'UNKNOWN'} · Market {m.identity.value?.marketId}</span>
        <span className="mt-1 block break-all text-xs text-ink-400">Collateral {m.collateral.value?.symbol ?? 'UNKNOWN'} · Maturity {time(m.identity.value?.maturity ? m.identity.value.maturity * 1000 : null)}</span>
        <span className="mt-2 block break-all text-xs">24h Volume {quantity(m.volume24hYu.value)} YU · Notional OI (one-sided) {quantity(m.notionalOiOneSidedYu.value)} YU</span>
        <span className="mt-1 block text-xs text-ink-400">Stats {status(m.volume24hYu, MARKET_TTL_MS, query.isError)} / {m.volume24hYu.completeness} · Bids {status(m.book.bids, BOOK_TTL_MS, query.isError)} / {m.book.bids.completeness} · Asks {status(m.book.asks, BOOK_TTL_MS, query.isError)} / {m.book.asks.completeness}</span>
      </button>)}</div>
    </section>)}</div>
    <div ref={diagnostics} className="scroll-mt-40">{current && <Diagnostics market={current} failed={query.isError} />}</div>
  </section>;
}
