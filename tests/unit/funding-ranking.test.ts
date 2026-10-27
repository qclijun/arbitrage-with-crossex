import { describe, expect, it } from 'vitest';
import type { HistoryDays } from '../../src/core/funding/history';
import { FundingHistoryCache, legKey } from '../../src/core/funding/history-cache';
import { enumerateFundingCandidates, rankFundingCandidates, type RankingRow } from '../../src/core/funding/ranking';
import { CUTOFF as C, D, H, M, NOW, flat, historyLeg, live, publish } from '../helpers/funding-ranking-fixture';

const legs = (c: { short: { venue: string; contractId: string }; long: { venue: string; contractId: string } }) =>
  `${c.short.venue}:${c.short.contractId}>${c.long.venue}:${c.long.contractId}`;

describe('directed funding candidates', () => {
  it('forms every cross-venue direction between proven comparable contracts, keeping exact contracts apart', () => {
    const { candidates, unpaired } = enumerateFundingCandidates([
      live('BINANCE', 'BTCUSDT'),
      live('BYBIT', 'BTCUSDT'),
      live('ASTER', 'BTCUSDT'),
    ]);
    expect(candidates.map(legs).sort()).toEqual([
      'ASTER:BTCUSDT>BINANCE:BTCUSDT', 'ASTER:BTCUSDT>BYBIT:BTCUSDT',
      'BINANCE:BTCUSDT>ASTER:BTCUSDT', 'BINANCE:BTCUSDT>BYBIT:BTCUSDT',
      'BYBIT:BTCUSDT>ASTER:BTCUSDT', 'BYBIT:BTCUSDT>BINANCE:BTCUSDT',
    ]);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(6);
    expect(unpaired).toEqual([]);

    // Two Binance BTC contracts are two identities, never merged by venue, and never paired with each other.
    const multi = enumerateFundingCandidates([
      live('BINANCE', 'BTCUSDT'),
      live('BINANCE', 'BTCUSDC'),
      live('BYBIT', 'BTCUSDT'),
    ]).candidates.map(legs).sort();
    expect(multi).toEqual([
      'BINANCE:BTCUSDC>BYBIT:BTCUSDT', 'BINANCE:BTCUSDT>BYBIT:BTCUSDT',
      'BYBIT:BTCUSDT>BINANCE:BTCUSDC', 'BYBIT:BTCUSDT>BINANCE:BTCUSDT',
    ]);
  });

  it('pairs only on a proven underlying and rate basis, and says why a contract has no candidate', () => {
    const { candidates, unpaired } = enumerateFundingCandidates([
      live('BINANCE', 'BTCUSDT'),
      live('BYBIT', 'BTCUSDT'),
      { ...live('ASTER', 'BTCUSDT'), underlying: null },
      { ...live('OKX', 'BTC-USDT-SWAP'), rateBasis: null },
      live('HYPERLIQUID', 'BTC', 'BTC', 'other-basis'),
      live('BINANCE', 'ETHUSDT', 'ETH'),
      live('BYBIT', 'SOLUSDT', 'SOL'),
      live('BYBIT', 'SOLPERP', 'SOL'),
      live('ASTER', 'ETHUSDT', 'ETH'),
      live('ASTER', 'ETHUSDT', 'ETH2'),
    ]);
    expect(candidates.map(legs).sort()).toEqual(['BINANCE:BTCUSDT>BYBIT:BTCUSDT', 'BYBIT:BTCUSDT>BINANCE:BTCUSDT']);
    expect(unpaired).toEqual([
      { venue: 'ASTER', contractId: 'BTCUSDT', reason: 'underlying-unverified' },
      { venue: 'ASTER', contractId: 'ETHUSDT', reason: 'identity-conflict' },
      { venue: 'BINANCE', contractId: 'ETHUSDT', reason: 'no-comparable-peer' },
      { venue: 'BYBIT', contractId: 'SOLPERP', reason: 'no-comparable-peer' },
      { venue: 'BYBIT', contractId: 'SOLUSDT', reason: 'no-comparable-peer' },
      { venue: 'HYPERLIQUID', contractId: 'BTC', reason: 'rate-basis-mismatch' },
      { venue: 'OKX', contractId: 'BTC-USDT-SWAP', reason: 'rate-basis-unverified' },
    ]);
  });
});

const btc = enumerateFundingCandidates([live('BINANCE', 'BTCUSDT'), live('BYBIT', 'BTCUSDT'), live('ASTER', 'BTCUSDT')]).candidates;
const windowOf = (row: RankingRow, days: number) => row.windows.find((w) => w.days === days)!;

describe('historical funding ranking', () => {
  // Per 8-hour settlement. 30 days: Binance 23 days at 0.0002, Bybit 7 days at 0.0003, Aster 0.0001 throughout.
  const cache = publish([
    historyLeg('BINANCE', 'BTCUSDT', flat('0.0002', '0')),
    historyLeg('BYBIT', 'BTCUSDT', flat('0', '0.0003')),
    historyLeg('ASTER', 'BTCUSDT', flat('0.0001')),
  ]);

  it('ranks every direction by its 30-day signed spread by default, keeping zero and reverse rows', () => {
    const page = rankFundingCandidates({ candidates: btc, history: cache, now: NOW });
    expect(page).toMatchObject({ snapshotId: 'snap-1', days: 30, compareDays: 7, candidateCount: 6, matched: 6, rankedCount: 6 });
    expect(page.rows.map((row) => [legs(row.candidate), windowOf(row, 30).netTotal, row.rank])).toEqual([
      ['BINANCE:BTCUSDT>BYBIT:BTCUSDT', '0.0075', 1],
      ['BINANCE:BTCUSDT>ASTER:BTCUSDT', '0.0048', 2],
      ['ASTER:BTCUSDT>BYBIT:BTCUSDT', '0.0027', 3],
      ['BYBIT:BTCUSDT>ASTER:BTCUSDT', '-0.0027', 4],
      ['ASTER:BTCUSDT>BINANCE:BTCUSDT', '-0.0048', 5],
      ['BYBIT:BTCUSDT>BINANCE:BTCUSDT', '-0.0075', 6],
    ]);
    expect(windowOf(page.rows[0], 30).netAnnualized).toBe('0.09125');
  });

  it('shows the current period beside history: a reversal is flagged, never re-ranked or re-legged', () => {
    const current = new Map([
      [legKey({ venue: 'BINANCE', contractId: 'BTCUSDT' }), { rate: '-0.0001', intervalHours: 8, at: NOW }],
      [legKey({ venue: 'BYBIT', contractId: 'BTCUSDT' }), { rate: '0.0002', intervalHours: 4, at: NOW }],
    ]);
    const blocked = (c: { short: { venue: string } }) => (c.short.venue === 'BINANCE' ? ['execution-whitelist'] : []);
    const page = rankFundingCandidates({ candidates: btc, history: cache, now: NOW, current, executionBlockers: blocked });
    const [top] = page.rows;
    expect(legs(top.candidate)).toBe('BINANCE:BTCUSDT>BYBIT:BTCUSDT');
    expect(top).toMatchObject({ rank: 1, executionBlockers: ['execution-whitelist'] });
    expect(windowOf(top, 30)).toMatchObject({ eligible: true, netTotal: '0.0075' });
    // -0.0001 × 1095 settlements a year minus 0.0002 × 2190.
    expect(top.current).toMatchObject({ short: { rate: '-0.0001' }, long: { rate: '0.0002', intervalHours: 4 },
      netAnnualized: '-0.5475', reversed: true });
    const reverse = page.rows.find((row) => legs(row.candidate) === 'BYBIT:BTCUSDT>BINANCE:BTCUSDT')!;
    expect(reverse.current).toMatchObject({ netAnnualized: '0.5475', reversed: true });
    // No current quote for Aster: no contrast, and the history row is unchanged.
    expect(page.rows[1]).toMatchObject({ rank: 2, current: null, executionBlockers: ['execution-whitelist'] });
    expect(page.rows.map((row) => legs(row.candidate)))
      .toEqual(rankFundingCandidates({ candidates: btc, history: cache, now: NOW }).rows.map((row) => legs(row.candidate)));

    // Stale history is not an established window to contrast with.
    const stale = rankFundingCandidates({ candidates: btc, history: cache, now: C + 17 * M, current });
    expect(stale.rows.find((row) => legs(row.candidate) === 'BINANCE:BTCUSDT>BYBIT:BTCUSDT')!.current)
      .toMatchObject({ netAnnualized: '-0.5475', reversed: null });
    // Bybit's 4-hour period quoted four hours ago is a past period, not the current one.
    const old = new Map(current).set(legKey({ venue: 'BYBIT', contractId: 'BTCUSDT' }), { rate: '0.0002', intervalHours: 4, at: NOW - 4 * H });
    expect(rankFundingCandidates({ candidates: btc, history: cache, now: NOW, current: old }).rows[0].current).toBeNull();
  });

  it('lets the 7-day best differ from the 30-day best without swapping a row\'s legs', () => {
    const page = rankFundingCandidates({ candidates: btc, history: cache, now: NOW, days: 7 });
    expect(page.rows.map((row) => [legs(row.candidate), windowOf(row, 7).netTotal])).toEqual([
      ['BYBIT:BTCUSDT>BINANCE:BTCUSDT', '0.0063'],
      ['BYBIT:BTCUSDT>ASTER:BTCUSDT', '0.0042'],
      ['ASTER:BTCUSDT>BINANCE:BTCUSDT', '0.0021'],
      ['BINANCE:BTCUSDT>ASTER:BTCUSDT', '-0.0021'],
      ['ASTER:BTCUSDT>BYBIT:BTCUSDT', '-0.0042'],
      ['BINANCE:BTCUSDT>BYBIT:BTCUSDT', '-0.0063'],
    ]);
    // Every window of one row reads the same short and long contracts.
    const last = page.rows[5];
    expect(last.windows.map((w) => w.days)).toEqual([7, 30, 90, 180, 365]);
    for (const w of last.windows) {
      expect(w.result).toMatchObject({ short: { venue: 'BINANCE' }, long: { venue: 'BYBIT' } });
    }
    expect(windowOf(last, 30).netTotal).toBe('0.0075');
  });
});

describe('observation rows', () => {
  const candidates = enumerateFundingCandidates([
    live('BINANCE', 'BTCUSDT'), live('BYBIT', 'BTCUSDT'), live('ASTER', 'BTCUSDT'),
    live('BINANCE', 'ETHUSDT', 'ETH'), live('BYBIT', 'ETHUSDT', 'ETH'),
  ]).candidates;
  // No Aster history was collected; Bybit ETH misses one settlement ten days back.
  const cache = publish([
    historyLeg('BINANCE', 'BTCUSDT', flat('0')),
    historyLeg('BYBIT', 'BTCUSDT', flat('0')),
    historyLeg('BINANCE', 'ETHUSDT', flat('0.0001')),
    historyLeg('BYBIT', 'ETHUSDT', flat('0.0001'), { drop: C - 10 * D }),
  ]);
  const summary = (row: RankingRow, days = 30) => [legs(row.candidate), row.rank, windowOf(row, days).reasons];

  it('keeps UNKNOWN rows with reasons after every ranked row instead of scoring them as zero', () => {
    const page = rankFundingCandidates({ candidates, history: cache, now: NOW });
    expect(page).toMatchObject({ candidateCount: 8, matched: 8, rankedCount: 2 });
    expect(page.rows.map((row) => summary(row))).toEqual([
      ['BINANCE:BTCUSDT>BYBIT:BTCUSDT', 1, []],
      ['BYBIT:BTCUSDT>BINANCE:BTCUSDT', 2, []],
      ['ASTER:BTCUSDT>BINANCE:BTCUSDT', null, ['short:history-leg-missing']],
      ['ASTER:BTCUSDT>BYBIT:BTCUSDT', null, ['short:history-leg-missing']],
      ['BINANCE:BTCUSDT>ASTER:BTCUSDT', null, ['long:history-leg-missing']],
      ['BYBIT:BTCUSDT>ASTER:BTCUSDT', null, ['long:history-leg-missing']],
      ['BINANCE:ETHUSDT>BYBIT:ETHUSDT', null, ['history-partial', 'long:missing-settlement']],
      ['BYBIT:ETHUSDT>BINANCE:ETHUSDT', null, ['history-partial', 'short:missing-settlement']],
    ]);
    const eth = page.rows[6];
    expect(windowOf(eth, 30)).toMatchObject({ eligible: false, coverage: 'partial', netTotal: null });
    // The shorter complete window still ranks: a gap ten days back does not touch the last seven.
    expect(windowOf(eth, 7)).toMatchObject({ eligible: true, coverage: 'complete', netTotal: '0', reasons: [] });
    expect(rankFundingCandidates({ candidates, history: cache, now: NOW, days: 7 }).rankedCount).toBe(4);
  });

  it('stops ranking stale or cold history but keeps every candidate observable', () => {
    const stale = rankFundingCandidates({ candidates, history: cache, now: C + 17 * M });
    expect(stale.rankedCount).toBe(0);
    expect(stale.rows.map((row) => summary(row)).slice(0, 2)).toEqual([
      ['ASTER:BTCUSDT>BINANCE:BTCUSDT', null, ['short:history-leg-missing']],
      ['ASTER:BTCUSDT>BYBIT:BTCUSDT', null, ['short:history-leg-missing']],
    ]);
    expect(windowOf(stale.rows[3], 30)).toMatchObject({ coverage: 'complete', netTotal: '0', eligible: false,
      reasons: ['short:history-stale', 'long:history-stale'] });
    // Into the next UTC hour the snapshot's cutoff is behind, whatever the verification age.
    expect(windowOf(rankFundingCandidates({ candidates, history: cache, now: C + 60 * M }).rows[3], 30).reasons)
      .toEqual(['history-cutoff-behind', 'short:history-stale', 'long:history-stale']);
    // A reader clock behind the snapshot has no window to evaluate.
    expect(windowOf(rankFundingCandidates({ candidates, history: cache, now: C - M }).rows[3], 30).reasons)
      .toEqual(['history-clock-behind']);

    const cold = rankFundingCandidates({ candidates, history: new FundingHistoryCache(), now: NOW });
    expect(cold).toMatchObject({ snapshotId: null, candidateCount: 8, matched: 8, rankedCount: 0 });
    expect(cold.rows.every((row) => row.windows.every((w) => w.coverage === 'unavailable'
      && w.reasons.join() === 'history-cold-start'))).toBe(true);
    expect(() => rankFundingCandidates({ candidates, history: cache, now: NOW, days: 14 as HistoryDays })).toThrow('Invalid ranking window');
  });

  it('reports a window its source cannot serve as unsupported', () => {
    const okx = enumerateFundingCandidates([live('BINANCE', 'BTCUSDT'), live('OKX', 'BTC-USDT-SWAP')]).candidates;
    const history = publish([historyLeg('BINANCE', 'BTCUSDT', flat('0')), historyLeg('OKX', 'BTC-USDT-SWAP', flat('0'))]);
    const [row] = rankFundingCandidates({ candidates: okx, history, now: NOW, days: 180 }).rows;
    expect(windowOf(row, 180)).toMatchObject({ eligible: false, coverage: 'unsupported', netTotal: null });
    expect(windowOf(row, 180).reasons[0]).toBe('history-unsupported');
    expect(windowOf(row, 90)).toMatchObject({ eligible: true, coverage: 'complete' });
  });
});

describe('exact order, filters and pages', () => {
  const coins = ['BTC', 'ETH', 'SOL', 'XRP'];
  const candidates = enumerateFundingCandidates(coins.flatMap((coin) =>
    [live('BINANCE', `${coin}USDT`, coin), live('BYBIT', `${coin}USDT`, coin)])).candidates;
  const cache = publish([
    historyLeg('BINANCE', 'BTCUSDT', flat('0.0001')), historyLeg('BYBIT', 'BTCUSDT', flat('0')),
    // 9e-10 above BTC and SOL over 30 days: equal at any practical display precision, still ahead.
    historyLeg('BINANCE', 'ETHUSDT', flat('0.00010000001')), historyLeg('BYBIT', 'ETHUSDT', flat('0')),
    historyLeg('BINANCE', 'SOLUSDT', flat('0.0001')), historyLeg('BYBIT', 'SOLUSDT', flat('0')),
    // Both legs negative: shorting -0.01% against longing -0.03% receives the 0.02% difference.
    historyLeg('BINANCE', 'XRPUSDT', flat('-0.0001')), historyLeg('BYBIT', 'XRPUSDT', flat('-0.0003')),
  ]);
  const full = [
    ['BINANCE:XRPUSDT>BYBIT:XRPUSDT', '0.018'],
    ['BINANCE:ETHUSDT>BYBIT:ETHUSDT', '0.0090000009'],
    ['BINANCE:BTCUSDT>BYBIT:BTCUSDT', '0.009'],
    ['BINANCE:SOLUSDT>BYBIT:SOLUSDT', '0.009'],
    ['BYBIT:BTCUSDT>BINANCE:BTCUSDT', '-0.009'],
    ['BYBIT:SOLUSDT>BINANCE:SOLUSDT', '-0.009'],
    ['BYBIT:ETHUSDT>BINANCE:ETHUSDT', '-0.0090000009'],
    ['BYBIT:XRPUSDT>BINANCE:XRPUSDT', '-0.018'],
  ];
  const view = (row: RankingRow) => [legs(row.candidate), windowOf(row, 30).netTotal];

  it('orders by the unrounded signed spread, breaking true ties by stable identity', () => {
    expect(rankFundingCandidates({ candidates, history: cache, now: NOW }).rows.map(view)).toEqual(full);
    // Input order does not matter.
    expect(rankFundingCandidates({ candidates: [...candidates].reverse(), history: cache, now: NOW }).rows.map(view)).toEqual(full);
  });

  it('sorts globally before paging, so pages of one snapshot neither skip nor repeat', () => {
    const pages = [0, 3, 6].map((offset) => rankFundingCandidates({ candidates, history: cache, now: NOW, page: { offset, limit: 3 } }));
    expect(pages.map((page) => page.rows.length)).toEqual([3, 3, 2]);
    expect(pages.flatMap((page) => page.rows.map(view))).toEqual(full);
    expect(pages.flatMap((page) => page.rows.map((row) => row.rank))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pages[2]).toMatchObject({ offset: 6, limit: 3, matched: 8, rankedCount: 8 });
  });

  it('filters the view by coin, venue or positive spread without dropping candidates', () => {
    const coin = rankFundingCandidates({ candidates, history: cache, now: NOW, filter: { underlyings: ['SOL', 'BTC'] } });
    expect(coin).toMatchObject({ candidateCount: 8, matched: 4, rankedCount: 4 });
    expect(coin.rows.map(view)).toEqual([full[2], full[3], full[4], full[5]]);

    const positive = rankFundingCandidates({ candidates, history: cache, now: NOW, filter: { positiveOnly: true }, page: { offset: 2, limit: 5 } });
    expect(positive).toMatchObject({ candidateCount: 8, matched: 4, rankedCount: 4 });
    expect(positive.rows.map((row) => [view(row)[0], row.rank])).toEqual([[full[2][0], 3], [full[3][0], 4]]);

    // Either leg on the venue matches.
    const aster = rankFundingCandidates({ candidates: btc, history: cache, now: NOW, filter: { venues: ['ASTER'] } });
    expect(aster.rows.map((row) => legs(row.candidate))).toEqual([
      'ASTER:BTCUSDT>BINANCE:BTCUSDT', 'ASTER:BTCUSDT>BYBIT:BTCUSDT', 'BINANCE:BTCUSDT>ASTER:BTCUSDT', 'BYBIT:BTCUSDT>ASTER:BTCUSDT',
    ]);
  });
});
