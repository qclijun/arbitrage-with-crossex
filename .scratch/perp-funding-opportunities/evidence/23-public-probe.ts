/** Manual public-only calibration; fixed hosts, <=11 serial requests, no retries. */
import axios from 'axios';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { bookRequestOptions } from '../../../src/core/estimate/books';

interface Request { name: string; url: string; body?: object; }
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const url = (base: string, params: Record<string, string | number>) => {
  const result = new URL(base);
  for (const [key, value] of Object.entries(params)) result.searchParams.set(key, String(value));
  return result.toString();
};

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('usage: yarn tsx .scratch/perp-funding-opportunities/evidence/23-public-probe.ts NEW_DIRECTORY [BINANCE,BYBIT]');
  // Refuse overwrites so an independent rerun cannot replace prior evidence.
  mkdirSync(output, { recursive: false });
  const cutoff = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const start = cutoff - 365 * 86_400_000;
  const plan: [string, Request[]][] = [
    ['BINANCE', [
      { name: 'history-small', url: url('https://fapi.binance.com/fapi/v1/fundingRate', { symbol: 'BTCUSDT', startTime: start, endTime: cutoff, limit: 1 }) },
      { name: 'instruments', url: 'https://fapi.binance.com/fapi/v1/exchangeInfo' },
    ]],
    ['ASTER', [
      { name: 'instruments', url: 'https://fapi.asterdex.com/fapi/v3/exchangeInfo' },
      { name: 'history-small', url: url('https://fapi.asterdex.com/fapi/v3/fundingRate', { symbol: 'BTCUSDT', startTime: start, endTime: cutoff, limit: 1 }) },
      { name: 'history-full', url: url('https://fapi.asterdex.com/fapi/v3/fundingRate', { symbol: 'BTCUSDT', startTime: start, endTime: cutoff, limit: 1000 }) },
    ]],
    ['OKX', [1, 400].map((limit) => ({ name: `history-${limit}`, url: url('https://www.okx.com/api/v5/public/funding-rate-history', { instId: 'BTC-USDT-SWAP', before: cutoff - 90 * 86_400_000 - 1, after: cutoff + 1, limit }) }))],
    ['BYBIT', [1, 200].map((limit) => ({ name: `history-${limit}`, url: url('https://api.bybit.com/v5/market/funding/history', { category: 'linear', symbol: 'BTCUSDT', startTime: start, endTime: cutoff, limit }) }))],
    ['HYPERLIQUID', [1, 365].map((days) => ({ name: `history-${days}d`, url: 'https://api.hyperliquid.xyz/info', body: { type: 'fundingHistory', coin: 'BTC', startTime: cutoff - days * 86_400_000, endTime: cutoff } }))],
  ];
  const venues = process.argv[3]?.split(',');
  if (venues?.some((venue) => !plan.some(([name]) => name === venue))) throw new Error('unknown venue');
  const selected = plan.filter(([venue]) => !venues || venues.includes(venue));
  const samples: object[] = [];
  const manifest = {
    startedAt: new Date().toISOString(), cutoff, spacingMs: 1500, timeoutMs: 5000,
    maxRequests: selected.reduce((sum, [, requests]) => sum + requests.length, 0), retries: 0,
    venues: selected.map(([venue]) => venue),
    transport: 'Existing bookRequestOptions (honors process GATE_PROXY); no persistent egress/config changes. Response set-cookie omitted; no account/auth headers.',
    samples,
  };
  const save = () => writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  save();
  let previousEnd = 0;
  for (const [venue, requests] of selected) {
    let minuteLimit: number | null = null;
    for (const request of requests) {
      await pause(Math.max(0, previousEnd + 1500 - Date.now()));
      const startedAt = new Date().toISOString();
      const at = performance.now();
      const identity = { venue, name: request.name, method: request.body ? 'POST' : 'GET', url: request.url, body: request.body ?? null, startedAt };
      try {
        const response = await axios.request({ ...bookRequestOptions(), url: request.url,
          method: identity.method, data: request.body, timeout: 5000, signal: AbortSignal.timeout(5000),
          responseType: 'arraybuffer', maxContentLength: 16 * 1024 * 1024, maxRedirects: 0,
          validateStatus: () => true });
        const elapsedMs = Math.round(performance.now() - at);
        const raw = Buffer.from(response.data);
        const bodyFile = `${venue.toLowerCase()}-${request.name}.body.gz`;
        writeFileSync(join(output, bodyFile), gzipSync(raw));
        const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => key.toLowerCase() !== 'set-cookie'));
        let parsed: any = null;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch { /* Preserve non-JSON denial bodies too. */ }
        const rows = Array.isArray(parsed) ? parsed : venue === 'OKX' ? parsed?.data : venue === 'BYBIT' ? parsed?.result?.list : null;
        const count = Array.isArray(rows) ? rows.length : null;
        const declared = parsed?.rateLimits?.find((r: any) => r.rateLimitType === 'REQUEST_WEIGHT' && r.interval === 'MINUTE' && r.intervalNum === 1);
        if (Number.isSafeInteger(declared?.limit) && declared.limit > 0) minuteLimit = declared.limit;
        const code = parsed?.retCode ?? parsed?.code ?? null;
        const limited = code === 10006 || code === 10429 || code === -1003 || code === '50011' || code === '50040';
        const validPayload = request.name === 'instruments' ? Array.isArray(parsed?.symbols) : Array.isArray(rows);
        const ok = response.status >= 200 && response.status < 300
          && validPayload && !limited && (venue !== 'OKX' || code === '0') && (venue !== 'BYBIT' || code === 0);
        const used = response.headers['x-mbx-used-weight-1m'];
        const stop = !ok || response.headers['retry-after'] !== undefined
          || response.headers['x-bapi-limit-status'] === '0'
          || (minuteLimit !== null && used !== undefined && Number(used) >= minuteLimit * 0.8);
        samples.push({ ...identity, status: response.status, elapsedMs, headers, code, count,
          bodyFile, bodyBytes: raw.length, bodySha256: sha256(raw), minuteLimit,
          hlDocumentedWeight: venue === 'HYPERLIQUID' && count !== null ? 20 + Math.ceil(count / 20) : null,
          stopVenue: stop, observation: ok ? 'HTTP/API success; no capacity or cooldown proof' : 'UNKNOWN: HTTP/API failure' });
        console.log(JSON.stringify({ venue, name: request.name, status: response.status, count, elapsedMs, stop }));
        if (stop) break;
      } catch (error) {
        samples.push({ ...identity, elapsedMs: Math.round(performance.now() - at), status: null,
          error: axios.isAxiosError(error) ? error.code ?? 'axios-error' : error instanceof Error ? error.name : 'unknown-error',
          observation: 'UNKNOWN: transport failure; no retry', stopVenue: true });
        console.log(JSON.stringify({ venue, name: request.name, status: null, stop: true }));
        break;
      } finally {
        previousEnd = Date.now();
        save();
      }
    }
  }
  console.log(JSON.stringify({ output, requests: samples.length }));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : 'probe-failed'); process.exitCode = 1; });
