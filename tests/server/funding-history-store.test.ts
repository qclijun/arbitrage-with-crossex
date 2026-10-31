import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openFundingHistoryStore } from '../../src/server/funding/history-store';
import { legKey, type CachedHistoryLeg } from '../../src/core/funding/history-cache';
import type { CollectionProgress } from '../../src/core/funding/history-collection';
import type { FundingHistoryLeg, SettledFundingEvent } from '../../src/core/funding/history';
import type { PersistedHistory } from '../../src/core/funding/history-persistence';

const H = 3_600_000;
const D = 24 * H;
const CUTOFF = Date.UTC(2026, 9, 31, 12);

let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-store-')); file = path.join(dir, 'funding-history.sqlite'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const event = (settledAt: number, rate: string, extra: Partial<SettledFundingEvent> = {}): SettledFundingEvent => ({
  settledAt, rate, intervalHours: 8, status: 'settled', kind: 'regular', evidence: `GET /fundingRate?end=${settledAt - (settledAt % D)}#hash`, ...extra });

function read(venue: string, contractId: string, opts: { start: number; verifiedAt: number; events: SettledFundingEvent[] }): FundingHistoryLeg {
  return {
    venue, contractId,
    cadence: { basis: 'inferred', intervals: [8], samples: opts.events.length },
    source: { kind: 'settled-history', api: '/fapi/v1/fundingRate', version: 'official-v1', status: 'verified' },
    observedAt: opts.verifiedAt - 2_000, verifiedAt: opts.verifiedAt,
    lastAttempt: { at: opts.verifiedAt + 600_000, outcome: 'error', reason: 'budget-exhausted' },
    listing: { at: 0, evidence: `${venue}/${contractId}/listing`, kind: 'listed-by' },
    pages: { complete: true, rangeStart: opts.start, rangeEnd: CUTOFF, termination: 'all-segments-done',
      pages: [{ request: 'GET /fundingRate', firstAt: opts.start + 8 * H, lastAt: CUTOFF, count: opts.events.length, cursor: null, rawHash: 'hash' }] },
    rules: [{ from: 0, until: CUTOFF + D, everyHours: 8, anchor: 0, evidence: 'inferred-cadence-v1' }],
    events: opts.events,
  };
}

const series = (start: number, end: number, rate = '0.0001') => {
  const out: SettledFundingEvent[] = [];
  for (let t = start + 8 * H; t <= end; t += 8 * H) out.push(event(t, rate));
  return out;
};

function world(): PersistedHistory {
  const binanceEvents = [...series(CUTOFF - 30 * D, CUTOFF),
    // A revised settlement kept beside the original, and a special one sharing a timestamp.
    event(CUTOFF - 8 * H, '0.0002'), event(CUTOFF - 8 * H, '0.00005', { kind: 'special' })];
  const binance: CachedHistoryLeg = {
    cutoff: CUTOFF,
    leg: read('BINANCE', 'BTCUSDT', { start: CUTOFF - 30 * D, verifiedAt: CUTOFF + 70_000, events: binanceEvents }),
    wider: read('BINANCE', 'BTCUSDT', { start: CUTOFF - 365 * D, verifiedAt: CUTOFF + 65_000, events: series(CUTOFF - 365 * D, CUTOFF) }),
  };
  const hlEvents = series(CUTOFF - 20 * D, CUTOFF).map((e) => ({ ...e, intervalHours: 1, rawTime: e.settledAt + 37,
    timeMappingEvidence: 'hl-time-mapping-v1;processing-skew<=999ms' }));
  const hlOld = CUTOFF - 3 * H;
  const hyperliquid: CachedHistoryLeg = {
    cutoff: CUTOFF,
    leg: { ...read('HYPERLIQUID', 'BTC', { start: CUTOFF - 20 * D, verifiedAt: CUTOFF + 61_000, events: hlEvents }), cadence: undefined },
    retained: [{ cutoff: hlOld, leg: read('HYPERLIQUID', 'BTC', { start: hlOld - 90 * D, verifiedAt: hlOld + 200_000,
      events: series(hlOld - 90 * D, hlOld) }) }],
    backfill: { cutoff: hlOld, completeThroughDays: 90, pendingDays: 180, pagesRead: 7 },
  };
  const job: CollectionProgress = {
    cutoff: hlOld, leg: { ...read('HYPERLIQUID', 'BTC', { start: 0, verifiedAt: hlOld + 200_000, events: [] }), verifiedAt: null },
    ranges: [{ start: hlOld - 20 * D, end: hlOld }, { start: hlOld - 30 * D, end: hlOld - 20 * D }, { start: hlOld - 90 * D, end: hlOld - 30 * D },
      { start: hlOld - 180 * D, end: hlOld - 90 * D }],
    segment: 3, cursor: String(hlOld - 120 * D), pageNo: 4, covered: hlOld - 90 * D,
    events: series(hlOld - 120 * D, hlOld), pages: [{ request: 'info:fundingHistory BTC', firstAt: 1, lastAt: 2, count: 500, cursor: 'c', rawHash: 'h' }],
    observedAt: hlOld + 100_000, verifiedAt: hlOld + 200_000, done: false,
  };
  const btc = { venue: 'HYPERLIQUID', contractId: 'BTC' };
  return {
    snapshot: { id: `fh-${CUTOFF}-${CUTOFF + 60_000}-9`, cutoff: CUTOFF, publishedAt: CUTOFF + 75_000,
      legs: new Map([[legKey({ venue: 'BINANCE', contractId: 'BTCUSDT' }), binance], [legKey(btc), hyperliquid]]) },
    progress: new Map([[legKey(btc), job]]),
    backfilled: new Map([[legKey(btc), 9]]),
  };
}

/** Everything that came off disk is a restored read: observation only until re-proven. */
function restored(state: PersistedHistory): PersistedHistory {
  const mark = (leg: FundingHistoryLeg): FundingHistoryLeg => ({ ...leg, restored: true });
  return {
    snapshot: { ...state.snapshot, legs: new Map([...state.snapshot.legs].map(([key, cached]) => [key, {
      ...cached, leg: mark(cached.leg), ...(cached.wider ? { wider: mark(cached.wider) } : {}),
      ...(cached.retained ? { retained: cached.retained.map((r) => ({ ...r, leg: mark(r.leg) })) } : {}),
    }])) },
    progress: new Map([...state.progress].map(([key, job]) => [key, { ...job, leg: mark(job.leg) }])),
    backfilled: state.backfilled,
  };
}

async function reopen() {
  const store = openFundingHistoryStore(file);
  try { return await store.load(); } finally { store.close(); }
}

it('restores the saved snapshot and backfill jobs verbatim, every read marked restored with its original timestamps', async () => {
  const state = world();
  const store = openFundingHistoryStore(file);
  expect(await store.load()).toEqual({ outcome: 'empty' });
  await store.save(state);
  store.close();
  const loaded = await reopen();
  expect(loaded.outcome).toBe('restored');
  if (loaded.outcome !== 'restored') return;
  const { savedAt, ...rest } = loaded.state;
  expect(savedAt).toEqual(expect.any(Number));
  expect(rest).toEqual(restored(state));
});

it('keeps the file equal to the latest state across saves: grown jobs, replaced reads, dropped legs, re-saved restored reads', async () => {
  const first = world();
  let store = openFundingHistoryStore(file);
  await store.load();
  await store.save(first);
  const binanceKey = legKey({ venue: 'BINANCE', contractId: 'BTCUSDT' });
  const hlKey = legKey({ venue: 'HYPERLIQUID', contractId: 'BTC' });
  const job = first.progress.get(hlKey)!;
  const grownJob: CollectionProgress = { ...job, segment: 4, cursor: null, pageNo: 0, covered: job.cutoff - 180 * D, done: true,
    events: [...job.events, event(job.cutoff - 121 * D, '0.0003', { evidence: 'info:fundingHistory BTC page 5#h5' })] };
  const hl = first.snapshot.legs.get(hlKey)!;
  const second: PersistedHistory = {
    snapshot: { id: 'fh-next', cutoff: CUTOFF + H, publishedAt: CUTOFF + H + 80_000,
      legs: new Map([[hlKey, { ...hl, cutoff: CUTOFF + H, backfill: undefined, retained: undefined,
        leg: read('HYPERLIQUID', 'BTC', { start: CUTOFF + H - 20 * D, verifiedAt: CUTOFF + H + 70_000, events: series(CUTOFF + H - 20 * D, CUTOFF + H, '-0.0001') }) }]]) },
    progress: new Map([[hlKey, grownJob]]),
    backfilled: new Map([[hlKey, 10]]),
  };
  await store.save(second);
  store.close();
  let loaded = await reopen();
  if (loaded.outcome !== 'restored') throw new Error(loaded.outcome);
  expect(loaded.state.snapshot.legs.has(binanceKey)).toBe(false);
  const { savedAt: _s, ...rest } = loaded.state;
  expect(rest).toEqual(restored({ ...second, snapshot: { ...second.snapshot,
    legs: new Map([[hlKey, { cutoff: CUTOFF + H, leg: second.snapshot.legs.get(hlKey)!.leg }]]) } }));

  // A restart that changes nothing, then saves its restored state again, must read back the same.
  store = openFundingHistoryStore(file);
  const again = await store.load();
  if (again.outcome !== 'restored') throw new Error(again.outcome);
  await store.save(again.state);
  store.close();
  loaded = await reopen();
  if (loaded.outcome !== 'restored') throw new Error(loaded.outcome);
  expect({ ...loaded.state, savedAt: 0 }).toEqual({ ...again.state, savedAt: 0 });
});

async function saved(state = world()) {
  const store = openFundingHistoryStore(file);
  await store.load();
  await store.save(state);
  store.close();
}

function tamper(sql: string) {
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
}

async function expectDiscardedThenUsable(reason: RegExp) {
  const store = openFundingHistoryStore(file);
  const result = await store.load();
  expect(result).toEqual({ outcome: 'discarded', reason: expect.stringMatching(reason) });
  // Rebuilt from nothing: the next save and restart work on a clean file.
  await store.save(world());
  store.close();
  expect((await reopen()).outcome).toBe('restored');
}

it('discards a cache written in another format version, whole', async () => {
  await saved();
  tamper('PRAGMA user_version = 2');
  await expectDiscardedThenUsable(/format version 2/);
});

it('discards a file that is not a database', async () => {
  fs.writeFileSync(file, 'not a database at all, just bytes '.repeat(200));
  await expectDiscardedThenUsable(/./);
});

it.each([
  ['an unreadable read body', "UPDATE reads SET body = '{' WHERE slot = 'wider'", /wider is not JSON/],
  ['a settlement with a non-integer time', "UPDATE settlements SET settled_at = 'soon' WHERE seq = 0 AND slot = 'leg'", /settlement/],
  ['a settlement pointing past its evidence list', "UPDATE settlements SET evidence = 999 WHERE seq = 1 AND slot = 'progress'", /settlement/],
  ['a read for another contract', "UPDATE reads SET body = replace(body, '\"contractId\":\"BTC\"', '\"contractId\":\"ETH\"') WHERE slot = 'leg'", /identity/],
  ['a missing snapshot record', 'DELETE FROM meta', /snapshot metadata missing/],
  ['a gap in the retained reads', "UPDATE reads SET slot = 'retained:1' WHERE slot = 'retained:0'; UPDATE settlements SET slot = 'retained:1' WHERE slot = 'retained:0'", /reads/],
])('discards everything, not just the bad leg, on %s', async (_name, sql, reason) => {
  await saved();
  tamper(sql);
  await expectDiscardedThenUsable(reason);
});

it.skipIf(process.platform === 'win32')('keeps the cache and its WAL files owner-only, even over a group-readable file', async () => {
  const old = process.umask(0o002);
  try {
    fs.writeFileSync(file, '', { mode: 0o644 });
    await saved();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      if (fs.existsSync(f)) expect((fs.statSync(f).mode & 0o777).toString(8), f).toBe('600');
    }
  } finally { process.umask(old); }
});
