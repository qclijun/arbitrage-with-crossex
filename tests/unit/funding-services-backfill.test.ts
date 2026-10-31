import { afterEach, expect, it, vi } from 'vitest';
import { createFundingServices } from '../../src/server/funding/services';
import { FUNDING_FEEDS } from '../../src/core/funding/feeds';
import { OKX_ARCHIVE_API } from '../../src/core/funding/history-sources';
import type { FundingHistorySource } from '../../src/core/funding/history-collector';
import { D, H, T, run } from '../helpers/funding-history-stub';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('finishes a cold native contract within the production venue budget before backfilling a peer', async () => {
  vi.useFakeTimers({ now: T + 60_000 });
  vi.spyOn(FUNDING_FEEDS, 'OKX').mockResolvedValue([]);
  const wires: string[] = [];
  const source: FundingHistorySource = {
    venue: 'OKX', api: OKX_ARCHIVE_API, version: 'fixture',
    context: async () => ({ listing: null, rules: [] }),
    async page(contractId, range, _cursor, call) {
      // Real archive pages charge the shared call budget for both manifests
      // and downloads. Model a 27-request cold read over five segments.
      const width = range.end - range.start;
      const requests = width > 180 * D ? 15 : width > 60 * D ? 9 : 1;
      for (let i = 0; i < requests; i += 1) {
        await call(`fixture ${contractId}/${range.start}/${i}`, async () => { wires.push(contractId); });
      }
      return { rows: [{ instId: contractId, fundingTime: String(range.end), realizedRate: '0.0001' }],
        rawHash: 'fixture', firstAt: range.end, lastAt: range.end, cursor: null, done: true };
    },
  };
  const services = createFundingServices({ sources: [source], contracts: async () => ['ETH', 'BTC'].map((asset) => ({
    venue: 'OKX', contractId: `${asset}-USDT-SWAP`, symbol: `OKX_FUTURE_${asset}_USDT`, underlying: null, rateBasis: null,
  })) });
  const report = await run(services);
  expect(report).toMatchObject({ requests: 40, venues: { OKX: { refreshed: 1, stopped: 'budget-exhausted' } } });
  expect(wires.slice(0, 27)).toEqual(Array(27).fill('BTC-USDT-SWAP'));
  const key = { venue: 'OKX', contractId: 'BTC-USDT-SWAP' };
  expect(services.funding.history.evaluate({ short: key, long: key, underlying: 'BTC', days: 365 }, T + H))
    .toMatchObject({ historyEligible: false, short: { observed: { events: 5, total: '0.0005' } } });
});
