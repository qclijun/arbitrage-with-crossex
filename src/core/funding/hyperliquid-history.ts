/** Independently reviewed historical context for native HyperCore BTC/ETH. */
import { createHash } from 'node:crypto';
import { snapshotCutoff } from './history';
import type { FundingHistorySource, HistoryCall } from './history-collector';
import { normalizeOfficialSettlement } from './history-sources';
import { HYPERLIQUID_HOURLY_POLICY, type HyperliquidHourlyPolicy } from './hyperliquid-policy';
import type { PublicRead } from './official-public';
import { settlementTimeMapping } from './settlement-time';

type Context = Awaited<ReturnType<FundingHistorySource['context']>>;
interface DocumentProof { cutoff: number; evidence: string; }
type DocumentCheck = { proof: DocumentProof | null; rejected: boolean };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = (value: string) => /^[0-9a-f]{64}$/.test(value);

function reviewedListing(policy: HyperliquidHourlyPolicy, coin: 'BTC' | 'ETH') {
  const first = policy.listedBy[coin];
  if (!first?.request || !hash(first.responseHash) || !policy.version || !hash(policy.archive.sha256)
    || !/^[A-Z2-7]{32}$/.test(policy.archive.cdxDigest) || !hash(policy.current.sha256)
    || !Number.isSafeInteger(policy.from) || !Number.isSafeInteger(policy.archive.capturedAt)
    || policy.from < policy.archive.capturedAt) return null;
  const evidence = `${first.request}#${first.responseHash};row-sha256=${sha256(JSON.stringify(first.raw))}`;
  const event = normalizeOfficialSettlement({ venue: 'HYPERLIQUID', api: 'info:fundingHistory', contractId: coin },
    first.raw, null, evidence, settlementTimeMapping('HYPERLIQUID', first.raw.time));
  if (!event) return null;
  const at = event.rawTime ?? event.settledAt;
  if (at < 0 || at > policy.from) return null;
  return { at, kind: 'listed-by' as const, evidence: `${evidence};listed-by=${at}`, anchor: event.settledAt };
}

export function createHyperliquidHistoryContext(opts: { read: PublicRead; now: () => number; policy?: HyperliquidHourlyPolicy }) {
  const policy = opts.policy ?? HYPERLIQUID_HOURLY_POLICY;
  let cached: { cutoff: number; at: number; valid: boolean | null; promise: Promise<DocumentCheck> } | null = null;
  const currentDocument = (call: HistoryCall): Promise<DocumentCheck> => {
    const at = opts.now();
    const cutoff = snapshotCutoff(at);
    if (cached?.cutoff === cutoff && at >= cached.at
      && at - cached.at < (cached.valid === false ? 60_000 : 5 * 60_000)) return cached.promise;
    const entry = { cutoff, at, valid: null as boolean | null,
      promise: Promise.resolve({ proof: null, rejected: false }) as Promise<DocumentCheck> };
    cached = entry;
    entry.promise = (async () => {
      try {
        const request = `GET ${policy.current.url}`;
        const document = await call(request, (signal) => opts.read('HYPERLIQUID', policy.current.url, signal));
        entry.valid = typeof document === 'string' && sha256(document) === policy.current.sha256;
        if (!entry.valid) return { proof: null, rejected: true };
        if (opts.now() < at) return { proof: null, rejected: false };
        return { proof: { cutoff, evidence: `${request}#${policy.current.sha256};checked-at=${opts.now()}` }, rejected: false };
      } catch {
        // Documentation failure cannot manufacture historical eligibility.
        entry.valid = false;
        return { proof: null, rejected: false };
      }
    })();
    return entry.promise;
  };
  return async (coin: string, native: Context, call: HistoryCall): Promise<Context> => {
    if (!native || (coin !== 'BTC' && coin !== 'ETH')) return native;
    if (native.rules.length && native.listing) return native;
    const first = reviewedListing(policy, coin);
    if (!first) return native;
    const { anchor, ...listedBy } = first;
    const listing = native.listing ?? listedBy;
    if (native.rules.length) return { ...native, listing };
    if (snapshotCutoff(opts.now()) < policy.from) return { listing, rules: [] };
    const check = await currentDocument(call);
    const current = check.proof;
    if (!current) return { listing, rules: [], ...(check.rejected ? { proofRejected: 'historical-policy-changed' as const } : {}) };
    return { listing, rules: [{ from: policy.from, until: current.cutoff + 1, everyHours: 1, anchor,
      evidence: `${policy.version};reviewed-hourly-invariant;${policy.archive.url}#${policy.archive.sha256};${current.evidence}` }] };
  };
}
