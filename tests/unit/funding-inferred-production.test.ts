import { afterEach, expect, it, vi } from 'vitest';
import { createFundingServices } from '../../src/server/funding/services';
import { buildFundingBoard } from '../../src/server/funding/board';
import { FUNDING_FEEDS } from '../../src/core/funding/feeds';
import { live } from '../helpers/funding-ranking-fixture';
import { T, run, stubSource } from '../helpers/funding-history-stub';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('production infers cadence and ranks all five windows without historical document rules', async () => {
  vi.useFakeTimers({ now: T + 60_000 });
  const sources = (['BINANCE', 'BYBIT'] as const).map((venue) => {
    vi.spyOn(FUNDING_FEEDS, venue).mockResolvedValue([]);
    const { source } = stubSource(venue);
    source.context = async () => ({ listing: null, rules: [] });
    return source;
  });
  const services = createFundingServices({ sources, contracts: async () => sources.map(({ venue }) => ({
    ...live(venue, 'BTCUSDT'), symbol: `${venue}_FUTURE_BTC_USDT`,
  })) });
  await run(services);
  const board = buildFundingBoard({ query: { days: 7, compareDays: 30, offset: 0, limit: 50, positiveOnly: false }, history: services.funding.history,
    market: services.opportunities.market.view(), admission: null, now: Date.now() });
  expect(board.rankedCount).toBe(2);
  for (const row of board.rows) for (const window of row.windows) {
    expect(window).toMatchObject({ eligible: true, coverage: 'complete', legs: {
      short: { cadence: { basis: 'inferred', intervals: [8] } }, long: { cadence: { basis: 'inferred', intervals: [8] } },
    } });
  }
  const positive = buildFundingBoard({ query: { days: 7, compareDays: 30, offset: 0, limit: 50, positiveOnly: true },
    history: services.funding.history, market: services.opportunities.market.view(), admission: null, now: Date.now() });
  expect(positive.rankedCount).toBe(1);
  expect(positive.rows[0]!.short.venue).toBe('BINANCE');
});
