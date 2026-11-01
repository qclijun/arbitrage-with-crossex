/** Official instrument descriptions; current funding intervals are never historical rules. */
import { createHash } from 'node:crypto';
import type { NativeFundingContract } from './contract-identity';
import type { PublicRead } from './official-public';

type Row = Record<string, unknown>;
function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('invalid-instruments');
  return value as Row[];
}
function listed(value: unknown, evidence: string): NativeFundingContract['listing'] {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) return null;
  const at = Number(value);
  return Number.isSafeInteger(at) && at > 0 ? { at, evidence } : null;
}

export const OFFICIAL_INSTRUMENT_VENUES = ['BINANCE', 'ASTER', 'OKX', 'BYBIT', 'HYPERLIQUID', 'GATE', 'LIGHTER'];
export async function readOfficialInstruments(venue: string, read: PublicRead): Promise<NativeFundingContract[]> {
  let url: string;
  switch (venue) {
    case 'BINANCE': url = 'https://fapi.binance.com/fapi/v1/exchangeInfo'; break;
    case 'ASTER': url = 'https://fapi.asterdex.com/fapi/v3/exchangeInfo'; break;
    case 'OKX': url = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP'; break;
    case 'BYBIT': url = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000'; break;
    case 'HYPERLIQUID': url = 'https://api.hyperliquid.xyz/info'; break;
    case 'GATE': url = 'https://api.gateio.ws/api/v4/futures/usdt/contracts'; break;
    case 'LIGHTER': url = 'https://mainnet.zklighter.elliot.ai/api/v1/orderBooks'; break;
    default: throw new Error('no-official-instrument-source');
  }
  const out: NativeFundingContract[] = [];
  const cursors = new Set<string>();
  for (let page = 0; page < 10; page += 1) {
    const body = venue === 'HYPERLIQUID' ? { type: 'meta' } : undefined;
    const data = await read(venue, url, AbortSignal.timeout(5_000), body) as any;
    const evidence = `${body ? 'POST' : 'GET'} ${url}${body ? ` ${JSON.stringify(body)}` : ''}#${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`;
    if ((venue === 'OKX' && data?.code !== '0') || (venue === 'BYBIT' && data?.retCode !== 0)
      || (venue === 'LIGHTER' && data?.code !== 200)) throw new Error('instrument-api-error');
    const records = rows(venue === 'OKX' ? data.data : venue === 'BYBIT' ? data.result?.list
      : venue === 'HYPERLIQUID' ? data?.universe : venue === 'GATE' ? data
        : venue === 'LIGHTER' ? data?.order_books : data?.symbols);
    if (!records.length && page === 0) throw new Error('empty-instrument-response');
    for (const r of records) {
      if (venue === 'BINANCE' || venue === 'ASTER') {
        if (typeof r.symbol !== 'string' || typeof r.baseAsset !== 'string' || r.quoteAsset !== 'USDT' || r.marginAsset !== 'USDT'
          || r.contractType !== 'PERPETUAL') continue;
        out.push({ venue, contractId: r.symbol, base: r.baseAsset, quote: 'USDT', linear: true,
          live: r.status === 'TRADING', listing: listed(r.onboardDate, evidence), evidence });
      } else if (venue === 'OKX') {
        if (typeof r.instId !== 'string' || typeof r.ctValCcy !== 'string' || r.instType !== 'SWAP'
          || r.ctType !== 'linear' || r.settleCcy !== 'USDT') continue;
        out.push({ venue, contractId: r.instId, base: r.ctValCcy, quote: 'USDT', linear: true,
          live: r.state === 'live', listing: listed(r.listTime, evidence), evidence });
      } else if (venue === 'BYBIT') {
        if (typeof r.symbol !== 'string' || typeof r.baseCoin !== 'string' || r.contractType !== 'LinearPerpetual'
          || r.quoteCoin !== 'USDT' || r.settleCoin !== 'USDT') continue;
        out.push({ venue, contractId: r.symbol, base: r.baseCoin, quote: 'USDT', linear: true,
          live: r.status === 'Trading', listing: listed(r.launchTime, evidence), evidence });
      } else if (venue === 'HYPERLIQUID') {
        if (typeof r.name !== 'string' || r.name.includes(':') || !Number.isSafeInteger(r.szDecimals)) continue;
        out.push({ venue, contractId: r.name, base: r.name, quote: 'USDC', linear: true,
          live: r.isDelisted !== true, listing: null, evidence });
      } else if (venue === 'GATE') {
        // USDT-settled `direct` contracts are linear; Gate writes create_time in seconds.
        if (typeof r.name !== 'string' || !r.name.endsWith('_USDT') || r.type !== 'direct') continue;
        const created = Number.isSafeInteger(r.create_time) ? (r.create_time as number) * 1000 : null;
        out.push({ venue, contractId: r.name, base: r.name.slice(0, -5), quote: 'USDT', linear: true,
          live: r.status === 'trading' && r.in_delisting !== true, listing: listed(created, evidence), evidence });
      } else if (venue === 'LIGHTER') {
        // Perps settle in USDC; spot books are written BASE/QUOTE.
        if (typeof r.symbol !== 'string' || r.symbol.includes('/') || r.market_type !== 'perp') continue;
        out.push({ venue, contractId: r.symbol, base: r.symbol, quote: 'USDC', linear: true,
          live: r.status === 'active' && r.is_frozen !== true, listing: listed(r.created_at, evidence), evidence });
      }
    }
    const next: unknown = venue === 'BYBIT' ? data.result?.nextPageCursor : '';
    if (next === '' || next == null) return out;
    if (typeof next !== 'string' || cursors.has(next)) throw new Error('instrument-pagination-stalled');
    cursors.add(next);
    const nextUrl = new URL(url);
    nextUrl.searchParams.set('cursor', next);
    url = nextUrl.toString();
  }
  throw new Error('instrument-page-limit');
}
