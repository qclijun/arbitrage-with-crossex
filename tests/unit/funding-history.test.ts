import { describe, expect, it } from 'vitest';
import {
  evaluateFundingHistory,
  evaluateFundingWindows,
  snapshotCutoff,
  type FundingHistoryLeg,
  type HistoryDays,
} from '../../src/core/funding/history';
import { normalizeOfficialSettlement, sourceBoundary } from '../../src/core/funding/history-sources';

const H = 3_600_000;
const D = 24 * H;
const cutoff = 30 * D;

function leg(venue: string, rate: string, hours = 8, listedAt = 0): FundingHistoryLeg {
  const names: Record<string, [string, string]> = {
    A: ['BINANCE', '/fapi/v1/fundingRate'], B: ['BYBIT', '/v5/market/funding/history'],
    C: ['ASTER', '/fapi/v3/fundingRate'], HL: ['HYPERLIQUID', 'info:fundingHistory'],
  };
  const [venueName, api] = names[venue] ?? [venue, `${venue}/settled`];
  return {
    venue: venueName,
    contractId: `${venueName}:BTC-PERP`,
    source: { kind: 'settled-history', api, version: 'v1', status: 'verified' },
    observedAt: cutoff + 60_000,
    verifiedAt: cutoff + 60_000,
    lastAttempt: { at: cutoff + 60_000, outcome: 'success' },
    listing: { at: listedAt, evidence: `${venue}/listing` },
    pages: { complete: true, rangeStart: 0, rangeEnd: cutoff,
      pages: [{ request: 'synthetic full range', firstAt: hours * H, lastAt: cutoff,
        count: cutoff / (hours * H), cursor: null, rawHash: 'synthetic-page-hash' }],
      termination: 'past window start' },
    rules: [{ from: 0, until: cutoff + H, everyHours: hours, anchor: 0, evidence: 'historical schedule' }],
    events: Array.from({ length: cutoff / (hours * H) }, (_, i) => ({
      settledAt: (i + 1) * hours * H, rate, intervalHours: hours,
      kind: 'regular' as const, status: 'settled' as const, evidence: `${venueName}/event/${i}`,
    })),
  };
}

function evaluate(short: FundingHistoryLeg, long: FundingHistoryLeg, days: HistoryDays = 7, now = cutoff + 2 * 60_000) {
  return evaluateFundingHistory({ snapshotId: 's1', underlying: 'BTC', cutoff, days, short, long, now });
}

describe('funding history contract', () => {
  it('uses one UTC cutoff and (start, cutoff], keeping zero and negative rates', () => {
    expect(snapshotCutoff(cutoff + H + 1)).toBe(cutoff + H);
    const short = leg('A', '0');
    const long = leg('B', '-0.001');
    short.events.push({ settledAt: cutoff - 7 * D, rate: '999', intervalHours: 8,
      kind: 'regular', status: 'settled', evidence: 'out-of-window row' });
    const result = evaluate(short, long);
    expect(result.coverage).toBe('complete');
    expect(result.historyEligible).toBe(true);
    expect(result.short.total).toBe('0');
    expect(result.long.total).toBe('-0.021');
    expect(result.netTotal).toBe('0.021');
    expect(result.netAnnualized).toBe('1.095');
    expect(result.start).toBe(cutoff - 7 * D);
  });

  it('deduplicates identical pages and rejects economic conflicts', () => {
    const short = leg('A', '0.001');
    const long = leg('B', '0');
    short.events.push({ ...short.events.at(-1)! });
    expect(evaluate(short, long).short.total).toBe('0.021');
    short.events.push({ settledAt: cutoff, rate: '0.002', intervalHours: 8,
      kind: 'regular', status: 'settled', evidence: 'conflicting raw row' });
    const result = evaluate(short, long);
    expect(result.short.coverage).toBe('unknown');
    expect(result.short.conflicts).toMatchObject([{
      settledAt: cutoff,
      variants: [{ rate: '0.001', intervalHours: 8 }, { rate: '0.002', intervalHours: 8 }],
    }]);
    expect(result.netTotal).toBeNull();
  });

  it('checks every settlement across an 8 to 4 hour schedule change', () => {
    const short = leg('A', '0.001');
    const change = cutoff - 4 * D;
    short.rules = [
      { from: 0, until: change, everyHours: 8, anchor: 0, evidence: 'old rule' },
      { from: change, until: cutoff + H, everyHours: 4, anchor: change, evidence: 'new rule' },
    ];
    short.events = [
      ...short.events.filter((event) => event.settledAt < change),
      ...Array.from({ length: (cutoff - change) / (4 * H) + 1 }, (_, i) => ({
        settledAt: change + i * 4 * H, rate: '0.001', intervalHours: 4,
        kind: 'regular' as const, status: 'settled' as const, evidence: `changed-schedule/${i}`,
      })),
    ];
    expect(evaluate(short, leg('B', '0')).coverage).toBe('complete');
    short.events = short.events.filter((event) => event.settledAt !== change + 4 * H);
    const result = evaluate(short, leg('B', '0'));
    expect(result.short.coverage).toBe('partial');
    expect(result.short.missingEvents).toContain(change + 4 * H);
  });

  it('allows a complete short window for a ten-day-old listing', () => {
    const short = leg('A', '0.001', 8, cutoff - 10 * D);
    const long = leg('B', '0');
    expect(evaluate(short, long, 7).historyEligible).toBe(true);
    const month = evaluate(short, long, 30);
    expect(month.short.coverage).toBe('unknown');
    expect(month.historyEligible).toBe(false);
    expect(month.short.missingRanges).toEqual([{ start: 0, end: cutoff - 10 * D,
      reason: 'listing-history-insufficient' }]);
  });

  it('isolates missing settlements and source failures to their own legs', () => {
    const failed = leg('HL', '0.001', 1);
    failed.events = failed.events.filter((event) => event.settledAt !== cutoff - H);
    expect(evaluate(failed, leg('B', '0')).short.coverage).toBe('partial');
    const other = leg('C', '0.002');
    expect(evaluate(other, leg('B', '0')).historyEligible).toBe(true);
    failed.lastAttempt = { at: cutoff + H, outcome: 'error', reason: 'rate limited' };
    failed.pages = { ...failed.pages, complete: false, termination: 'page 2 failed' };
    expect(evaluate(failed, leg('B', '0')).short.reasons).toContain('page-incomplete');
  });

  it('requires proof and freshness independently of fee or execution blockers', () => {
    const short = leg('A', '0.001');
    const long = leg('B', '0');
    const stale = evaluate(short, long, 7, cutoff + 17 * 60_000);
    expect(stale.coverage).toBe('complete');
    expect(stale.fresh).toBe(false);
    expect(stale.historyEligible).toBe(false);
    expect(evaluate(short, long, 7, cutoff + 2 * H).fresh).toBe(false);
    short.rules = [];
    expect(evaluate(short, long).short.coverage).toBe('unknown');
    short.source.status = 'unsupported';
    expect(evaluate(short, long).short.coverage).toBe('unsupported');
  });

  it('keeps all five windows on one cutoff and one fixed direction', () => {
    const short = leg('A', '0.001', 8, cutoff - 10 * D);
    const long = leg('B', '0.002');
    const windows = evaluateFundingWindows({ snapshotId: 's1', underlying: 'BTC', cutoff,
      short, long, now: cutoff + 2 * 60_000 });
    expect(windows.map((window) => window.days)).toEqual([7, 30, 90, 180, 365]);
    expect(windows.map((window) => window.cutoff)).toEqual([cutoff, cutoff, cutoff, cutoff, cutoff]);
    expect(windows[0].netTotal).toBe('-0.021');
    expect(windows.slice(1).every((window) => window.netTotal === null)).toBe(true);
    expect(evaluate(long, short).netTotal).toBe('0.021');
  });

  it('does not treat predicted cutoff rates or pre-cutoff verification as settled history', () => {
    const short = leg('A', '0.001');
    short.events.at(-1)!.status = 'predicted';
    expect(evaluate(short, leg('B', '0')).short.coverage).toBe('unknown');
    short.events.at(-1)!.status = 'settled';
    short.verifiedAt = cutoff - 1;
    expect(evaluate(short, leg('B', '0')).short.reasons).toContain('verification-missing');
  });

  it('adds Binance special funding separately from regular funding', () => {
    const short = leg('A', '0.001');
    short.events.push({ settledAt: cutoff, rate: '-0.0005', intervalHours: 8,
      kind: 'special', status: 'settled', evidence: 'official special settlement' });
    const one = evaluate(short, leg('B', '0')).short;
    expect(one.coverage).toBe('complete');
    expect(one.total).toBe('0.0205');
    expect(one.specialEvents).toMatchObject([{ rate: '-0.0005', evidence: 'official special settlement' }]);
    short.events.push({ settledAt: cutoff, rate: '0.0002', intervalHours: 8,
      kind: 'special', status: 'settled', evidence: 'official special settlement' });
    expect(evaluate(short, leg('B', '0')).short.conflicts[0].variants).toHaveLength(2);
  });

  it('normalizes only proven official settled-history records', () => {
    const okx = { venue: 'OKX', api: '/api/v5/public/funding-rate-history', contractId: 'BTC-USDT-SWAP' };
    expect(normalizeOfficialSettlement(okx, {
      instId: 'BTC-USDT-SWAP', fundingTime: String(cutoff), fundingRate: '999', realizedRate: '-0.001',
    }, 8, 'raw-hash')).toMatchObject({ rate: '-0.001', status: 'settled', evidence: 'raw-hash' });
    expect(normalizeOfficialSettlement(okx, {
      instId: 'BTC-USDT-SWAP', fundingTime: String(cutoff), fundingRate: '999',
    }, 8, 'raw-hash')).toBeNull();
    expect(sourceBoundary('OKX', okx.api, 180)).toBe('unsupported');
    expect(sourceBoundary('OKX', '/api/v5/public/funding-rate', 7)).toBe('unknown');
    expect(sourceBoundary('GATE', '/futures/usdt/funding_rate', 7)).toBe('unknown');
    expect(sourceBoundary('LIGHTER', '/api/v1/fundings', 7)).toBe('unknown');
    const unproved = leg('A', '0.001');
    unproved.source.api = '/fapi/v1/premiumIndex';
    expect(evaluate(unproved, leg('B', '0')).short.coverage).toBe('unknown');
    const hl = { venue: 'HYPERLIQUID', api: 'info:fundingHistory', contractId: 'BTC' };
    const raw = { coin: 'BTC', time: cutoff + 76, fundingRate: '0.001' };
    expect(normalizeOfficialSettlement(hl, raw, 1, 'raw-hash')).toBeNull();
    expect(normalizeOfficialSettlement(hl, raw, 1, 'raw-hash',
      { settlementAt: cutoff, evidence: 'verified hour mapping' })).toMatchObject({
      settledAt: cutoff, rawTime: cutoff + 76, timeMappingEvidence: 'verified hour mapping',
    });
  });

  it('keeps execution blockers separate from historical eligibility', () => {
    const result = evaluateFundingHistory({ snapshotId: 's2', underlying: 'BTC', cutoff, days: 7,
      short: leg('A', '0.001'), long: leg('B', '0'), now: cutoff + 2 * 60_000,
      executionBlockers: ['account-fees-unknown'] });
    expect(result.historyEligible).toBe(true);
    expect(result.executionBlockers).toEqual(['account-fees-unknown']);
  });
});
