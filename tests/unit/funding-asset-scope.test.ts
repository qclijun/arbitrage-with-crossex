import { afterEach, expect, it, vi } from 'vitest';
import { createFundingServices } from '../../src/server/funding/services';
import { buildFundingBoard } from '../../src/server/funding/board';
import { buildSettlementBoard } from '../../src/server/funding/settlements';
import { FUNDING_FEEDS } from '../../src/core/funding/feeds';
import { live } from '../helpers/funding-ranking-fixture';
import { T, run, stubSource } from '../helpers/funding-history-stub';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('collects, ranks and lists only the configured assets', async () => {
  vi.useFakeTimers({ now: T + 60_000 });
  const stubs = (['BINANCE', 'BYBIT'] as const).map((venue) => {
    vi.spyOn(FUNDING_FEEDS, venue).mockResolvedValue([]);
    return stubSource(venue);
  });
  const services = createFundingServices({ sources: stubs.map((s) => s.source), contracts: async () => stubs.flatMap(({ source: { venue } }) =>
    ['BTC', 'ETH', 'SOL'].map((asset) => ({ ...live(venue, `${asset}USDT`, asset), symbol: `${venue}_FUTURE_${asset}_USDT` }))) });
  await run(services);
  for (const { calls } of stubs) expect(new Set(calls.map((c) => c.split(':')[0]))).toEqual(new Set(['BTCUSDT', 'ETHUSDT']));
  const market = services.opportunities.market.view();
  const board = buildFundingBoard({ query: { days: 7, compareDays: 30, offset: 0, limit: 50, positiveOnly: false },
    history: services.funding.history, market, admission: null, now: Date.now() });
  expect(board.options.underlyings).toEqual(['BTC', 'ETH']);
  expect(board.candidateCount).toBe(4);
  const settlements = buildSettlementBoard({ query: { offset: 0, limit: 50 }, history: services.funding.history, market, now: Date.now() });
  expect(settlements.options.underlyings).toEqual(['BTC', 'ETH']);
  expect(services.funding.legOf('BINANCE_FUTURE_SOL_USDT')).toBeNull();
});
