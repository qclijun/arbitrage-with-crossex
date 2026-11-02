/** Gate's public funding history (REST, probed 2026-11-01) and monthly archive (probed 2026-11-02). */
import { gzipSync } from 'node:zlib';
import type { PublicRead } from '../../src/core/funding/official-public';
import { mapFundingContracts } from '../../src/core/funding/contract-identity';
import type { FundingContractListing } from '../../src/core/funding/market';

const H = 3_600_000;
const D = 24 * H;
export const GATE_RATES = ['0.0003', '0', '-0.0001'] as const;

/**
 * Settlements every 4 hours since `cutoff - 60 days`, every 8 hours before (rate
 * 0.0001); the 4-hour ones cycle GATE_RATES back from `cutoff`. Each `t` is the
 * settlement second plus 0..5 s of processing delay. `from` is inclusive, `to`
 * exclusive, rows newest first, at most `limit`; `from` over 180 days before
 * `now()` is refused, like Gate's 400.
 */
export function gateHistory(cutoff: number, now: () => number, opts: { fail?: (url: URL) => boolean; drop?: number } = {}) {
  const requests: string[] = [];
  const settlements: Array<{ at: number; r: string }> = [];
  for (let i = 0, at = cutoff; at > cutoff - 400 * D; i += 1) {
    if (at !== opts.drop) settlements.push({ at, r: at > cutoff - 60 * D ? GATE_RATES[i % 3]! : '0.0001' });
    at -= at > cutoff - 60 * D ? 4 * H : 8 * H;
  }
  const stamp = (at: number) => at / 1_000 + (at / H) % 6;
  const read: PublicRead = async (venue, raw, _signal, _body, format) => {
    requests.push(raw);
    const url = new URL(raw);
    if (url.hostname === 'download.gatedata.org') {
      // funding_applies/YYYYMM/BTC_USDT-YYYYMM.csv.gz: that UTC month's records, oldest first.
      const [, , yyyymm] = url.pathname.split('/').slice(1);
      const month = Date.UTC(Number(yyyymm!.slice(0, 4)), Number(yyyymm!.slice(4)) - 1);
      const end = Date.UTC(Number(yyyymm!.slice(0, 4)), Number(yyyymm!.slice(4)));
      if (format !== 'binary' || end > now()) throw new Error('official-http-404');
      return gzipSync(settlements.filter(({ at }) => at >= month && at < end).reverse()
        .map(({ at, r }) => `${stamp(at)},${r}`).join('\n') + '\n');
    }
    if (venue !== 'GATE' || url.pathname !== '/api/v4/futures/usdt/funding_rate') throw new Error(`unexpected ${raw}`);
    if (opts.fail?.(url)) throw new Error('official-http-502');
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const limit = Number(url.searchParams.get('limit'));
    if (from < Math.floor(now() / 1_000) - 180 * 86_400 - 10 || limit > 1000) throw new Error('official-http-400');
    return settlements.map(({ at, r }) => ({ r, t: stamp(at) }))
      .filter(({ t }) => t >= from && t < to).slice(0, limit);
  };
  return { read, requests };
}

export const gateListing = { at: Date.UTC(2019, 10, 18), evidence: 'GET /futures/usdt/contracts#fixture create_time' };

export function gateFundingListing(coin: 'BTC' | 'ETH'): FundingContractListing {
  const product = { venue: 'GATE', base: coin, quote: 'USDT', contractId: `${coin}_USDT`, linear: true, live: true,
    listing: gateListing, evidence: 'synthetic official Gate contract' };
  return mapFundingContracts([{ symbol: `GATE_FUTURE_${coin}_USDT`, exchangeType: 'GATE', businessType: 'FUTURE',
    state: 'live', delistTime: '0' }], [product]).listings[0]!;
}
