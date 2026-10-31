import { afterEach, expect, it } from 'vitest';
import type { BoardRow, FundingBoard } from '../../src/server/funding/board';
import { boardWorld, type BoardWorld } from '../helpers/funding-board-fixture';
import { nativeFundingHistories, nativeFundingListings } from '../helpers/funding-hyperliquid-fixture';
import { legKey } from '../../src/core/funding/history-cache';
import { CUTOFF, D, H, NOW, publish } from '../helpers/funding-ranking-fixture';

let world: BoardWorld | undefined;
afterEach(async () => { await world?.app.close(); });
const isHlOkx = (r: BoardRow) => r.short.venue === 'HYPERLIQUID' && r.long.venue === 'OKX';

it('ranks ETH short HL / long OKX at equal notional with hourly vs eight-hour inferred settlements', async () => {
  world = await boardWorld({ listings: nativeFundingListings('ETH'), history: publish(nativeFundingHistories('ETH')) });
  const sourceCalls = [...world.sourceCalls];
  const board: FundingBoard = (await world.get('?underlying=ETH&days=7')).body.data;
  expect(board).toMatchObject({ candidateCount: 12, rankedCount: 12 });
  const row = board.rows.find(isHlOkx)!;
  expect(row).toMatchObject({ rateEstimate: { short: { price: 'oracle', settlement: 'USDC' }, long: { price: 'mark', settlement: 'USDT' } },
    executionBlockers: ['funding-valuation-unnormalized'] });
  // HL earns 168 * .00002, OKX pays 21 * .0001. Difference .00126; APR .00126 * 365 / 7 = .0657.
  expect(row.windows[0]).toMatchObject({ eligible: true, coverage: 'complete', netTotal: '0.00126', netAnnualized: '0.0657',
    legs: { short: { cadence: { basis: 'inferred', intervals: [1] } }, long: { cadence: { basis: 'inferred', intervals: [8] } } } });
  const reverse = board.rows.find((r) => r.short.venue === 'OKX' && r.long.venue === 'HYPERLIQUID')!;
  expect(reverse.windows[0]).toMatchObject({ netTotal: '-0.00126', netAnnualized: '-0.0657' });
  expect(row.windows.every((w) => w.eligible && w.cutoff === row.windows[0]!.cutoff)).toBe(true);
  expect(board.admission?.open).toBe(false);
  expect(world.sourceCalls).toEqual(sourceCalls);
});

it('preserves CEX values and relative order while filtering and paging all twelve BTC/ETH directions', async () => {
  const listings = [...nativeFundingListings('BTC'), ...nativeFundingListings('ETH')];
  const history = publish([...nativeFundingHistories('BTC'), ...nativeFundingHistories('ETH')]);
  const cexWorld = await boardWorld({ listings: listings.filter((l) => l.venue !== 'HYPERLIQUID'), history });
  let cexBoard: FundingBoard;
  try { cexBoard = (await cexWorld.get('?days=7')).body.data; } finally { await cexWorld.app.close(); }
  world = await boardWorld({ listings, history });
  const all: FundingBoard = (await world.get('?days=7')).body.data;
  expect(all).toMatchObject({ candidateCount: 24, rankedCount: 24 });
  const retained = all.rows.filter((r) => r.short.venue !== 'HYPERLIQUID' && r.long.venue !== 'HYPERLIQUID');
  expect(retained.map((r) => [r.id, r.windows])).toEqual(cexBoard.rows.map((r) => [r.id, r.windows]));
  const eth: FundingBoard = (await world.get('?underlying=ETH&days=7')).body.data;
  expect(eth).toMatchObject({ candidateCount: 24, matched: 12, rankedCount: 12 });
  expect(eth.rows.some((r) => r.windows[0]?.netTotal === '0')).toBe(true);
  expect(eth.rows.some((r) => r.windows[0]?.netTotal === '-0.00126')).toBe(true);
  const hl: FundingBoard = (await world.get('?underlying=ETH&venue=HYPERLIQUID&days=7')).body.data;
  expect(hl).toMatchObject({ matched: 6, rankedCount: 6 });
  expect(hl.rows.every((r) => r.rateEstimate)).toBe(true);
  const positive: FundingBoard = (await world.get('?underlying=ETH&venue=HYPERLIQUID&positive=1&days=7')).body.data;
  expect(positive).toMatchObject({ matched: 2, rankedCount: 2 });
  expect(positive.rows.every((r) => r.short.venue === 'HYPERLIQUID')).toBe(true);
  const ids: string[] = [];
  for (const offset of [0, 5, 10]) {
    const page: FundingBoard = (await world.get(`?underlying=ETH&days=7&limit=5&offset=${offset}&rankingId=${eth.rankingId}`)).body.data;
    expect(page.rankingChanged).toBe(false);
    ids.push(...page.rows.map((r) => r.id));
  }
  expect(ids).toEqual(eth.rows.map((r) => r.id));
});

it.each(['missing', 'conflict', 'pagination', 'stale', 'cutoff'] as const)('keeps failed HL %s history out of rankings without damaging CEX pairs', async (failure) => {
  const legs = nativeFundingHistories('ETH');
  const hl = legs.find((l) => l.venue === 'HYPERLIQUID')!;
  if (failure === 'missing') hl.events.splice(-2, 1);
  if (failure === 'conflict') hl.events.push({ ...hl.events.at(-1)!, rate: '0.123' });
  if (failure === 'pagination') hl.pages.complete = false;
  if (failure === 'stale') hl.verifiedAt = NOW - H;
  if (failure === 'cutoff') {
    hl.pages.rangeEnd = CUTOFF - H;
    hl.events = hl.events.filter((e) => e.settledAt <= hl.pages.rangeEnd);
  }
  const history = publish(legs);
  if (failure === 'cutoff') {
    const snapshot = history.snapshot()!;
    const legs = new Map(snapshot.legs);
    legs.set(legKey(hl), { ...legs.get(legKey(hl))!, cutoff: CUTOFF - H });
    history.publish({ ...snapshot, legs }, history.view(NOW).lastRound!);
  }
  world = await boardWorld({ listings: nativeFundingListings('ETH'), history });
  const board: FundingBoard = (await world.get('?days=7')).body.data;
  expect(board).toMatchObject({ candidateCount: 12, rankedCount: 6 });
  for (const row of board.rows.filter((r) => r.rateEstimate)) {
    expect(row.rank).toBeNull();
    expect(row.windows[0]?.eligible).toBe(false);
  }
  expect(board.rows.filter((r) => !r.rateEstimate).every((r) => r.rank !== null)).toBe(true);
});

it('evaluates each window independently when only older HL settlements are missing', async () => {
  const legs = nativeFundingHistories('ETH');
  const hl = legs.find((l) => l.venue === 'HYPERLIQUID')!;
  hl.events = hl.events.filter((e) => e.settledAt !== CUTOFF - 100 * D);
  world = await boardWorld({ listings: nativeFundingListings('ETH'), history: publish(legs) });
  const recent: FundingBoard = (await world.get('?days=7')).body.data;
  const row = recent.rows.find(isHlOkx)!;
  expect(row.rank).not.toBeNull();
  expect(row.windows.map((w) => [w.days, w.eligible])).toEqual([[7, true], [30, true], [90, true], [180, false], [365, false]]);
  expect(row.windows[4]).toMatchObject({ netTotal: null, netAnnualized: null });
  const long: FundingBoard = (await world.get('?days=365')).body.data;
  expect(long.rows.find(isHlOkx)?.rank).toBeNull();
  expect(long.rows.filter((r) => !r.rateEstimate).every((r) => r.rank !== null)).toBe(true);
});
