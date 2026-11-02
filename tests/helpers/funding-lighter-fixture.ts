/** A public Lighter fundings endpoint with the semantics probed on 2026-11-02. */
import type { PublicRead } from '../../src/core/funding/official-public';
import { mapFundingContracts } from '../../src/core/funding/contract-identity';
import type { FundingContractListing } from '../../src/core/funding/market';

const H = 3_600_000;
/** Hourly, back from the cutoff: +0.0012 %, 0, then -0.0004 % (shorts pay). Each three hours net 0.000008. */
export const LIGHTER_ROWS = [['0.0012', 'long'], ['0.0000', 'long'], ['0.0004', 'short']] as const;
export const lighterListing = { at: 1_737_098_461_107, evidence: 'GET /api/v1/orderBooks#fixture created_at' };
const books = { code: 200, order_books: [
  { symbol: 'ETH', market_id: 0, market_type: 'perp' }, { symbol: 'BTC', market_id: 1, market_type: 'perp' },
  { symbol: 'ETH/USDC', market_id: 2048, market_type: 'spot' },
] };

/**
 * Rows match `start <= t < end`, oldest first; the newest 750 are kept, and the
 * oldest match is dropped unless `end` passes the newest settlement.
 */
export function lighterHistory(cutoff: number, opts: { fail?: (url: URL) => boolean; drop?: number } = {}) {
  const requests: string[] = [];
  let newest = cutoff;
  const read: PublicRead = async (venue, raw) => {
    requests.push(raw);
    const url = new URL(raw);
    if (venue !== 'LIGHTER') throw new Error(`unexpected ${raw}`);
    if (url.pathname === '/api/v1/orderBooks') return books;
    if (url.pathname !== '/api/v1/fundings' || url.searchParams.get('resolution') !== '1h') throw new Error(`unexpected ${raw}`);
    if (opts.fail?.(url)) throw new Error('official-http-502');
    const start = Number(url.searchParams.get('start_timestamp')) * 1_000;
    const end = Number(url.searchParams.get('end_timestamp')) * 1_000;
    const rows = [];
    for (let at = Math.ceil(start / H) * H; at < end && at <= newest; at += H) {
      const [rate, direction] = LIGHTER_ROWS[((newest - at) / H) % 3]!;
      if (at !== opts.drop) rows.push({ timestamp: at / 1_000, value: '0.93354960', rate, direction });
    }
    const kept = rows.slice(-750);
    return { code: 200, resolution: '1h', fundings: end > newest ? kept : kept.slice(1) };
  };
  return { read, requests, settle: (at: number) => { newest = at; } };
}

export function lighterFundingListing(coin: 'BTC' | 'ETH'): FundingContractListing {
  const product = { venue: 'LIGHTER', base: coin, quote: 'USDC', contractId: coin, linear: true, live: true,
    listing: lighterListing, evidence: 'synthetic official Lighter perp book' };
  return mapFundingContracts([{ symbol: `LIGHTER_FUTURE_${coin}_USDC`, exchangeType: 'LIGHTER', businessType: 'FUTURE',
    state: 'live', delistTime: '0' }], [product]).listings[0]!;
}

