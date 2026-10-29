/** Explicit read-only public probe. Not imported by verify; never reads account APIs. */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publicCrossEx } from '../../../src/core/clients';
import { mapFundingContracts, type NativeFundingContract } from '../../../src/core/funding/contract-identity';
import { createOfficialPublicReader, type PublicReadSample } from '../../../src/core/funding/official-public';
import { createOfficialHistorySources } from '../../../src/core/funding/official-history';
import { OFFICIAL_HISTORY_VENUES, readOfficialInstruments } from '../../../src/core/funding/official-instruments';

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('usage: yarn tsx .scratch/perp-funding-opportunities/evidence/22-public-probe.ts /tmp/result.json');
  const requests: PublicReadSample[] = [];
  const read = createOfficialPublicReader({ sample: (s) => requests.push(s) });
  const sources = createOfficialHistorySources({ read });
  const cutoff = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const attempts: object[] = [];
  const errorText = (error: unknown) => error instanceof Error ? error.message : 'unknown-error';
  let rules: Awaited<ReturnType<ReturnType<typeof publicCrossEx>['listCrossexRuleSymbols']>>['body'] = [];
  try {
    rules = (await publicCrossEx().listCrossexRuleSymbols()).body;
    attempts.push({ venue: 'CROSSEX', kind: 'rules', count: rules.length,
      rawHash: createHash('sha256').update(JSON.stringify(rules)).digest('hex'),
      reviewed: rules.filter((r) => /_FUTURE_(BTC|ETH|HYPE)_/.test(r.symbol)) });
  } catch (error) { attempts.push({ venue: 'CROSSEX', kind: 'rules', error: errorText(error) }); }
  const allNative: NativeFundingContract[] = [];
  for (const venue of OFFICIAL_HISTORY_VENUES) {
    const source = sources.find((s) => s.venue === venue)!;
    let native;
    try {
      native = await readOfficialInstruments(venue, read);
      allNative.push(...native);
      attempts.push({ venue, kind: 'instruments', count: native.length, reviewed: native.filter((n) => ['BTC', 'ETH', 'HYPE'].includes(n.base)) });
    } catch (error) {
      attempts.push({ venue, kind: 'instruments', error: errorText(error) });
    }
    const contracts = [venue === 'OKX' ? 'BTC-USDT-SWAP' : venue === 'HYPERLIQUID' ? 'BTC' : 'BTCUSDT',
      venue === 'OKX' ? 'HYPE-USDT-SWAP' : venue === 'HYPERLIQUID' ? 'HYPE' : 'HYPEUSDT'];
    const newest = native?.filter((n) => n.live && n.listing).sort((a, b) => b.listing!.at - a.listing!.at)[0];
    if (newest && !contracts.includes(newest.contractId)) contracts.push(newest.contractId);
    for (const [index, contractId] of contracts.entries()) {
      const days = index === 0 ? source.maxDays ?? 365 : 7;
      const range = { start: cutoff - days * 86_400_000, end: cutoff };
      let cursor: string | null = null;
      for (let pageNo = 0; pageNo < (index === 0 ? 2 : 1); pageNo += 1) {
        try {
          const page = await source.page(contractId, range, cursor, (_request, run) => run(AbortSignal.timeout(5_000)));
          const times = page.rows.map((r) => Number(r.time ?? r.fundingTime ?? r.fundingRateTimestamp)).sort((a, b) => a - b);
          const gaps = [...new Set(times.slice(1).map((t, i) => t - times[i]!))].slice(0, 12);
          attempts.push({ venue, kind: 'history', contractId, days, range, pageNo, inputCursor: cursor,
            count: page.rows.length, firstAt: page.firstAt, lastAt: page.lastAt, done: page.done,
            cursor: page.cursor, rawHash: page.rawHash, observedGapsMs: gaps,
            rawHourOffsetsMs: [...new Set(times.map((t) => t % 3_600_000))].slice(0, 12) });
          cursor = page.cursor;
          if (page.done) break;
        } catch (error) {
          attempts.push({ venue, kind: 'history', contractId, pageNo, error: errorText(error) });
          break;
        }
      }
    }
  }
  const discovery = mapFundingContracts(rules, allNative);
  const rejectedCounts: Record<string, number> = {};
  for (const r of discovery.rejected) rejectedCounts[r.symbol.split('_')[0]!] = (rejectedCounts[r.symbol.split('_')[0]!] ?? 0) + 1;
  attempts.push({ kind: 'mapping', listings: discovery.listings.length, rejectedCounts,
    provedEconomics: discovery.listings.filter((l) => l.underlying).map((l) => ({ venue: l.venue, contractId: l.contractId, underlying: l.underlying!.id })) });
  writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), cutoff, requests, attempts,
    limits: 'Two-page maximum for BTC, one for HYPE/newest. Observed gaps do not prove cadence. No induced 429 or account calls.' }, null, 2) + '\n');
  console.log(JSON.stringify({ output, requests: requests.length, errors: attempts.filter((a) => 'error' in a).length }));

}
void main().catch((error) => { console.error(error instanceof Error ? error.message : 'probe-failed'); process.exitCode = 1; });
