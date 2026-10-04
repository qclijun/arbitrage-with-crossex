import { RefreshCw } from 'lucide-react';
import { useBorosCollateral } from '../api/queries';
import type { BorosCollateralPool } from '../api/types';
import { useTrackedAddress } from './trackedAddress';

const qty = (n: number | null) => n === null ? 'UNKNOWN' : n.toLocaleString('en-US', { maximumFractionDigits: 8 });
const ratio = (n: number | null) => n === null ? 'UNKNOWN' : `${n.toFixed(2)}×`;

function MarginBar({ label, margin, net }: { label: string; margin: number | null; net: number | null }) {
  const usage = margin !== null && net !== null && net > 0 ? margin / net : null;
  return <div className="mt-3">
    <div className="mb-1 flex justify-between text-xs text-ink-400"><span>{label} usage</span>
      <span className="num">{usage === null ? 'UNKNOWN' : `${(usage * 100).toFixed(1)}%`}</span></div>
    <div className="h-1.5 overflow-hidden rounded-full bg-ink-800" aria-hidden="true">
      <div className={usage !== null && usage >= 1 ? 'h-full bg-guava' : 'h-full bg-info'}
        style={{ width: `${usage === null ? 0 : Math.min(100, Math.max(0, usage * 100))}%` }} />
    </div>
  </div>;
}

function Pool({ pool, symbol, price }: { pool: BorosCollateralPool; symbol: string; price: number | null }) {
  const usd = pool.netBalance !== null && price !== null ? pool.netBalance * price : null;
  const knownEmpty = pool.netBalance === 0 && pool.initialMargin === 0
    && pool.maintenanceMargin === 0 && pool.activePositions === 0;
  return <>
    {knownEmpty && <p className="mb-3 text-sm text-ink-400">No balance in this pool.</p>}
    <p className="text-xs text-ink-400">Net balance</p>
    <p className="num mt-1 text-3xl font-semibold text-ink-50">{qty(pool.netBalance)} <span className="text-base">{symbol}</span></p>
    <p className="num mt-1 text-xs text-ink-500">{usd === null ? 'USD estimate UNKNOWN' : `≈ $${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}</p>
    <dl className="mt-5 space-y-2 text-sm">
      {([
        ['Available initial margin', `${qty(pool.availableInitialMargin)} ${symbol}`],
        ['Initial margin (IM)', `${qty(pool.initialMargin)} ${symbol}`],
        ['Maintenance margin (MM)', `${qty(pool.maintenanceMargin)} ${symbol}`],
        ['Active positions', pool.activePositions === null ? 'UNKNOWN' : String(pool.activePositions)],
        ['IM coverage', ratio(pool.imCoverage)], ['MM coverage', ratio(pool.mmCoverage)],
      ] as const).map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-ink-400">{label}</dt><dd className="num text-right text-ink-100">{value}</dd></div>)}
    </dl>
    <MarginBar label="IM" margin={pool.initialMargin} net={pool.netBalance} />
    <MarginBar label="MM" margin={pool.maintenanceMargin} net={pool.netBalance} />
    <p className="mt-4 text-[11px] leading-relaxed text-ink-500">Coverage = net balance ÷ required margin. Usage = required margin ÷ net balance. MM = net balance − available maintenance margin. Zero required margin has no coverage ratio.</p>
  </>;
}

export function CollateralPanel() {
  const { address } = useTrackedAddress();
  const query = useBorosCollateral(address);
  // Defense against old wallet data, including mocked or persisted queries.
  const data = query.data?.address.toLowerCase() === address?.toLowerCase() ? query.data : undefined;
  const stale = query.isError || data?.stale === true;
  return <section aria-label="Boros collateral">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold text-ink-50">Boros collateral</h2>
        <p className="mt-1 text-sm text-ink-400">Collateral and margin by token · read-only</p>
        {address && <p className="num mt-2 break-all text-xs text-ink-500">{address}{data && ` · Account ${data.accountId}`}</p>}
      </div>
      <button type="button" disabled={!address || query.isFetching} onClick={() => void query.refetch()}
        className="flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200 disabled:opacity-40"><RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />Refresh</button>
    </div>
    {!address ? <p className="text-sm text-ink-400">Select a Boros wallet in Settings to view collateral.</p> : <>
      <p className="mb-4 text-xs text-ink-400" role="status">{stale ? 'UNKNOWN · live collateral read failed or is stale. ' : query.isPending ? 'Loading collateral… ' : ''}
        {data ? `${stale ? 'Last successful snapshot' : 'Updated'}: ${new Date(data.observedAt).toLocaleString()}. ${stale ? 'Values below are old data.' : 'Refreshes every 15 seconds while this page is active.'}` : stale ? 'No successful snapshot available.' : ''}</p>
      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {(data?.tokens ?? ['ETH', 'BTC', 'USDT'].map((symbol, i) => ({ symbol, tokenId: i, priceUsd: null, cross: null, isolated: [] }))).map((token) => <article key={token.symbol} className="rounded-xl border border-ink-700 bg-ink-900/60 p-6">
          <h3 className="mb-5 flex items-center gap-3 text-lg font-semibold text-ink-50"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-info/10 text-info">{token.symbol === 'ETH' ? 'Ξ' : token.symbol === 'BTC' ? '₿' : '₮'}</span>{token.symbol} collateral</h3>
          <h4 className="mb-3 text-xs font-medium text-info">Cross margin</h4>
          {token.cross ? <Pool pool={token.cross} symbol={token.symbol} price={token.priceUsd} /> : <p className="text-sm text-ink-400">{!data ? 'UNKNOWN' : 'No cross margin account.'}</p>}
          {data && !token.cross && token.isolated.length === 0 && <p className="mt-3 text-sm text-ink-400">No balance in this token account.</p>}
          {token.isolated.map((pool) => <div key={pool.marketAcc} className="mt-6 border-t border-ink-700 pt-4"><h4 className="mb-3 text-xs font-medium text-info">Isolated margin · Market {parseInt(pool.marketAcc.slice(-6), 16)}</h4><Pool pool={pool} symbol={token.symbol} price={token.priceUsd} /></div>)}
        </article>)}
      </div>
    </>}
  </section>;
}
