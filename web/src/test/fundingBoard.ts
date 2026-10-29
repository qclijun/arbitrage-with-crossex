/** Invented opportunities-page payloads (ticket 18) for UI tests; nothing here is a venue read. */
import type { BoardRow, BoardWindow, FundingBoard } from '../api/fundingOpportunities';

const CUTOFF = Date.UTC(2026, 9, 1);
const DAYS = [7, 30, 90, 180, 365] as const;

const legHistory = (total: string, annualized: string, coverage: 'complete' | 'unknown' | 'unsupported' = 'complete') => ({
  coverage, fresh: true, total: coverage === 'complete' ? total : null, annualized: coverage === 'complete' ? annualized : null,
  source: { kind: 'settled-history' as const, api: '/fapi/v1/fundingRate', version: 'v1', status: 'verified' as const },
  verifiedAt: CUTOFF + 60_000, lastAttempt: { at: CUTOFF + 60_000, outcome: 'success' as const },
  reasons: coverage === 'complete' ? [] : [`source-${coverage}`], missingEvents: 0, missingRanges: [], conflicts: 0, specialEvents: 0,
});

export function boardWindow(days: BoardWindow['days'], net: string | null, over: Partial<BoardWindow> = {}): BoardWindow {
  return {
    days, eligible: net !== null, coverage: net !== null ? 'complete' : 'unknown', netTotal: net, netAnnualized: net, reasons: [],
    start: CUTOFF - days * 86_400_000, cutoff: CUTOFF,
    legs: net !== null ? { short: legHistory('0.03', '0.36'), long: legHistory('-0.006', '-0.07') } : null, ...over,
  };
}

export function boardRow(underlying: string, short: string, long: string, rank: number | null, net30: string | null, over: Partial<BoardRow> = {}): BoardRow {
  const [sv, sc] = short.split(' ');
  const [lv, lc] = long.split(' ');
  return {
    id: JSON.stringify([underlying, sv, sc, lv, lc]), underlying,
    short: { venue: sv, contractId: sc, symbol: `${sv}_FUTURE_${underlying}_USDT` },
    long: { venue: lv, contractId: lc, symbol: `${lv}_FUTURE_${underlying}_USDT` },
    rank, windows: DAYS.map((d) => boardWindow(d, d === 30 ? net30 : net30 === null ? null : '0.1')), current: null, executionBlockers: [], ...over,
  };
}

export function fundingBoard(over: Partial<FundingBoard> = {}): FundingBoard {
  const rows = [
    boardRow('BTC', 'BINANCE BTCUSDT', 'BYBIT BTCUSDT', 1, '0.438', {
      current: { short: { rate: '0.0001', intervalHours: 8, at: CUTOFF }, long: { rate: '0.0002', intervalHours: 8, at: CUTOFF },
        netAnnualized: '-0.1095', reversed: true },
    }),
    boardRow('BTC', 'BYBIT BTCUSDT', 'BINANCE BTCUSDT', 2, '-0.438'),
    boardRow('ETH', 'BINANCE ETHUSDT', 'OKX ETH-USDT-SWAP', null, null, {
      windows: DAYS.map((d) => boardWindow(d, null, { coverage: 'unsupported', reasons: ['history-unsupported', 'long:historical-source-unsupported'],
        legs: { short: legHistory('0.01', '0.1'), long: legHistory('', '', 'unsupported') } })),
    }),
    boardRow('PEPE', 'BINANCE 1000PEPEUSDT', 'OKX PEPE-USDT-SWAP', null, null, {
      windows: DAYS.map((d) => boardWindow(d, null, { coverage: 'unknown', reasons: ['history-unknown', 'short:missing-settlement'] })),
      executionBlockers: ['coin-unsupported', 'short:unit-unsupported'],
    }),
  ];
  return {
    snapshotId: 'snap-1', days: 30, compareDays: 7, candidateCount: 4, matched: 4, rankedCount: 2, offset: 0, limit: 50, rows,
    evaluatedAt: CUTOFF + 120_000, rankingId: 'a'.repeat(64), rankingChanged: false,
    options: { underlyings: ['BTC', 'ETH', 'PEPE'], venues: ['BINANCE', 'BYBIT', 'OKX'] },
    history: { state: 'ready', snapshotId: 'snap-1', cutoff: CUTOFF, cutoffBehind: false, publishedAt: CUTOFF + 60_000, refreshing: false,
      lastRound: { startedAt: CUTOFF + 60_000, finishedAt: CUTOFF + 60_000, cutoff: CUTOFF, outcome: 'published', requests: 12, venues: {} } },
    contracts: { state: 'ready', at: CUTOFF, lastAttempt: { at: CUTOFF, ok: true }, count: 7, unpaired: [{ venue: 'BYBIT', contractId: 'DOGEUSDT', reason: 'underlying-unverified' }] },
    feeds: [{ venue: 'BINANCE', ok: true, at: CUTOFF, count: 400, error: null }, { venue: 'OKX', ok: false, at: null, count: 0, error: 'network' }],
    admission: { open: false, generation: 0, reason: 'never-enabled', changedAt: null, enabledVersion: null },
    ...over,
  };
}
