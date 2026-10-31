/**
 * The funding history cache file (`funding-history.sqlite` beside the ledger):
 * rebuildable evidence, separate from the ledger's schema, version and backups.
 * The history refresher is its only writer; the ledger's EXCLUSIVE lock already
 * makes this the only terminal process. A save writes only what changed, one
 * transaction per leg, yielding between legs so the engine loop keeps running.
 * Anything that does not read back exactly discards the whole file.
 */
import * as fs from 'node:fs';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { legKey, type CachedHistoryLeg } from '../../core/funding/history-cache';
import type { CollectionProgress } from '../../core/funding/history-collection';
import type { SettledFundingEvent } from '../../core/funding/history';
import type { HistoryLoad, HistoryPersistence, PersistedHistory } from '../../core/funding/history-persistence';
import { restrictToOwner } from '../secretFile';
import { userVersion } from '../../engine/ledger/sqlite';
import {
  CorruptHistoryCache, decodeBackfill, decodeEvent, decodeProgress, decodeRead, decodeStrings, encodeLeg,
  type SettlementRow, type SlotRecord,
} from './history-store-codec';

/** Cache format, unrelated to the ledger version. A different value discards the file. */
export const HISTORY_CACHE_FORMAT = 1;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE legs (id INTEGER PRIMARY KEY, venue TEXT NOT NULL, contract_id TEXT NOT NULL, cutoff INTEGER,
  backfill TEXT, backfilled INTEGER, UNIQUE (venue, contract_id));
CREATE TABLE reads (leg_id INTEGER NOT NULL, slot TEXT NOT NULL, cutoff INTEGER NOT NULL, observed_at INTEGER,
  verified_at INTEGER, body TEXT NOT NULL, strings TEXT NOT NULL, PRIMARY KEY (leg_id, slot)) WITHOUT ROWID;
CREATE TABLE settlements (leg_id INTEGER NOT NULL, slot TEXT NOT NULL, seq INTEGER NOT NULL, settled_at INTEGER NOT NULL,
  raw_time INTEGER, rate TEXT NOT NULL, interval_hours INTEGER, status TEXT NOT NULL, kind TEXT NOT NULL,
  evidence INTEGER NOT NULL, time_mapping_evidence INTEGER, PRIMARY KEY (leg_id, slot, seq)) WITHOUT ROWID;
CREATE INDEX settlements_by_time ON settlements (leg_id, settled_at);
PRAGMA user_version = ${HISTORY_CACHE_FORMAT};`;

/** What one slot holds on disk, kept to diff the next save against. */
interface SavedSlot { body: string; strings: string[]; index: Map<string, number>; events: SettledFundingEvent[] }
interface SavedLeg { id: number; row: string; slots: Map<string, SavedSlot> }

const YIELD_EVERY_MS = 8;

function statements(db: DatabaseSync) {
  return {
    upsertLeg: db.prepare(`INSERT INTO legs (venue, contract_id, cutoff, backfill, backfilled) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (venue, contract_id) DO UPDATE SET cutoff = excluded.cutoff, backfill = excluded.backfill,
      backfilled = excluded.backfilled RETURNING id`),
    upsertRead: db.prepare('INSERT OR REPLACE INTO reads VALUES (?, ?, ?, ?, ?, ?, ?)'),
    insertSettlement: db.prepare('INSERT INTO settlements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    deleteSlot: db.prepare('DELETE FROM settlements WHERE leg_id = ? AND slot = ?'),
    deleteRead: db.prepare('DELETE FROM reads WHERE leg_id = ? AND slot = ?'),
    deleteLeg: [db.prepare('DELETE FROM settlements WHERE leg_id = ?'), db.prepare('DELETE FROM reads WHERE leg_id = ?'),
      db.prepare('DELETE FROM legs WHERE id = ?')],
    legs: db.prepare('SELECT * FROM legs ORDER BY id'),
    reads: db.prepare('SELECT * FROM reads WHERE leg_id = ?'),
    settlements: db.prepare('SELECT * FROM settlements WHERE leg_id = ? ORDER BY slot, seq'),
    meta: db.prepare("SELECT value FROM meta WHERE key = 'snapshot'"),
    setMeta: db.prepare("INSERT OR REPLACE INTO meta VALUES ('snapshot', ?)"),
  };
}
type Statements = ReturnType<typeof statements>;

function removeFiles(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

function openDb(file: string): DatabaseSync {
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  restrictToOwner(file);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000');
    const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
    if (userVersion(db) === 0 && tables === 0) db.exec(SCHEMA);
    for (const side of [`${file}-wal`, `${file}-shm`]) if (fs.existsSync(side)) restrictToOwner(side);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Shutdown arrived mid-load: nothing is wrong with the file. */
class CacheClosed extends Error { constructor() { super('history-cache-closed'); } }

/** Only a file that does not read back is discarded; IO or permission trouble leaves it for the next start. */
function corrupt(err: unknown): boolean {
  if (err instanceof CorruptHistoryCache) return true;
  const code = (err as { errcode?: unknown } | null)?.errcode;
  // SQLITE_CORRUPT, SQLITE_NOTADB; a missing table or column is a schema this code did not write.
  return code === 11 || code === 26 || /malformed|not a database|no such (table|column)/i.test(message(err));
}

export function openFundingHistoryStore(file: string): HistoryPersistence {
  let db: DatabaseSync | null = null;
  let sql: Statements | null = null;
  let saved = new Map<string, SavedLeg>();
  let loaded = false;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let busy = 0;

  function connect(): void {
    db = openDb(file);
    sql = statements(db);
  }

  function disconnect(): void {
    try { db?.close(); } catch { /* already unusable */ }
    db = null;
    sql = null;
  }

  async function read(): Promise<HistoryLoad> {
    connect();
    const version = userVersion(db!);
    if (version !== HISTORY_CACHE_FORMAT) throw new CorruptHistoryCache(`format version ${version}, expected ${HISTORY_CACHE_FORMAT}`);
    const meta = sql!.meta.get() as { value: string } | undefined;
    const rows = sql!.legs.all() as Array<{ id: number; venue: string; contract_id: string; cutoff: number | null;
      backfill: string | null; backfilled: number | null }>;
    if (!meta && !rows.length) return { outcome: 'empty' };
    if (!meta) throw new CorruptHistoryCache('snapshot metadata missing');
    let snapshot: { id: string; cutoff: number; publishedAt: number; savedAt: number };
    try { snapshot = JSON.parse(meta.value); } catch { throw new CorruptHistoryCache('snapshot metadata is not JSON'); }
    if (typeof snapshot?.id !== 'string' || ![snapshot.cutoff, snapshot.publishedAt, snapshot.savedAt].every(Number.isSafeInteger)) {
      throw new CorruptHistoryCache('snapshot metadata');
    }
    const legs = new Map<string, CachedHistoryLeg>();
    const progress = new Map<string, CollectionProgress>();
    const backfilled = new Map<string, number>();
    const mirror = new Map<string, SavedLeg>();
    let lastYield = Date.now();
    for (const row of rows) {
      if (closed) throw new CacheClosed();
      const key = legKey({ venue: row.venue, contractId: row.contract_id });
      const what = `${row.venue}/${row.contract_id}`;
      const events = new Map<string, SettledFundingEvent[]>();
      const reads = sql!.reads.all(row.id) as Array<{ slot: string; cutoff: number; body: string; strings: string }>;
      const slots = new Map<string, SavedSlot>();
      const strings = new Map(reads.map((r) => [r.slot, decodeStrings(r.strings, `${what} ${r.slot}`)]));
      for (const s of sql!.settlements.all(row.id) as unknown as SettlementRow[]) {
        const dictionary = strings.get(s.slot);
        if (!dictionary) throw new CorruptHistoryCache(`${what} ${s.slot} settlements without a read`);
        const list = events.get(s.slot) ?? [];
        list.push(decodeEvent(s, dictionary, `${what} ${s.slot}`));
        events.set(s.slot, list);
      }
      let leg: CachedHistoryLeg['leg'] | undefined;
      let wider: CachedHistoryLeg['wider'];
      const retained: NonNullable<CachedHistoryLeg['retained']> = [];
      for (const r of reads) {
        const list = events.get(r.slot) ?? [];
        const dictionary = strings.get(r.slot)!;
        slots.set(r.slot, { body: r.body, strings: dictionary, index: new Map(dictionary.map((s, i) => [s, i])), events: [...list] });
        if (!Number.isSafeInteger(r.cutoff)) throw new CorruptHistoryCache(`${what} ${r.slot} cutoff`);
        if (r.slot === 'progress') progress.set(key, decodeProgress(r.body, list, row.venue, row.contract_id));
        else if (r.slot === 'leg') leg = decodeRead(r.body, list, row.venue, row.contract_id, `${what} leg`);
        else if (r.slot === 'wider') wider = decodeRead(r.body, list, row.venue, row.contract_id, `${what} wider`);
        else if (/^retained:\d+$/.test(r.slot)) {
          retained[Number(r.slot.slice('retained:'.length))] = { cutoff: r.cutoff, leg: decodeRead(r.body, list, row.venue, row.contract_id, `${what} ${r.slot}`) };
        } else throw new CorruptHistoryCache(`${what} unknown slot ${r.slot}`);
      }
      if (Array.from(retained).some((r) => r === undefined) || ((wider || retained.length || row.backfill !== null) && !leg)
        || (!leg && !progress.has(key)) || (leg && !Number.isSafeInteger(row.cutoff))) throw new CorruptHistoryCache(`${what} reads`);
      if (leg) legs.set(key, { cutoff: row.cutoff!, leg, ...(wider ? { wider } : {}), ...(retained.length ? { retained } : {}),
        ...(row.backfill !== null ? { backfill: decodeBackfill(row.backfill) } : {}) });
      if (row.backfilled !== null) {
        if (!Number.isSafeInteger(row.backfilled)) throw new CorruptHistoryCache(`${what} backfilled`);
        backfilled.set(key, row.backfilled);
      }
      mirror.set(key, { id: row.id, row: legRow(legs.get(key), backfilled.get(key)), slots });
      if (Date.now() - lastYield >= YIELD_EVERY_MS) { await yieldToLoop(); lastYield = Date.now(); }
    }
    saved = mirror;
    const { savedAt, ...snap } = snapshot;
    return { outcome: 'restored', state: { snapshot: { ...snap, legs }, progress, backfilled, savedAt } };
  }

  /** Rebuild from nothing: whatever was there is not trusted at all. */
  function discard(reason: string): HistoryLoad {
    disconnect();
    saved = new Map();
    try {
      removeFiles(file);
      connect();
      return { outcome: 'discarded', reason };
    } catch (err) {
      disconnect();
      return { outcome: 'unavailable', reason: `${reason}; rebuild failed: ${message(err)}` };
    }
  }

  async function load(): Promise<HistoryLoad> {
    if (loaded) throw new Error('history-cache-already-loaded');
    if (closed) return { outcome: 'unavailable', reason: 'history-cache-closed' };
    loaded = true;
    busy += 1;
    try {
      return await read();
    } catch (err) {
      if (closed || !corrupt(err)) {
        disconnect();
        saved = new Map();
        return { outcome: 'unavailable', reason: message(err) };
      }
      return discard(message(err));
    } finally {
      busy -= 1;
      if (closed && !busy) disconnect();
    }
  }

  function writeLeg(key: string, records: SlotRecord[], row: string, cached: CachedHistoryLeg | undefined, rotation: number | undefined): void {
    const [venue, contractId] = key.split('\u0000') as [string, string];
    const before = saved.get(key);
    const plans = records.map((record) => ({ record, plan: planSlot(before?.slots.get(record.slot), record) }));
    const gone = [...(before?.slots.keys() ?? [])].filter((slot) => !records.some((r) => r.slot === slot));
    if (before && before.row === row && !gone.length && plans.every((p) => p.plan.kind === 'same')) return;
    const s = sql!;
    db!.exec('BEGIN');
    try {
      const { id } = s.upsertLeg.get(venue, contractId, cached?.cutoff ?? null,
        cached?.backfill ? JSON.stringify(cached.backfill) : null, rotation ?? null) as { id: number };
      for (const slot of gone) { s.deleteSlot.run(id, slot); s.deleteRead.run(id, slot); }
      for (const { record, plan } of plans) {
        if (plan.kind === 'same') continue;
        if (plan.kind === 'rewrite') s.deleteSlot.run(id, record.slot);
        for (let seq = plan.from; seq < record.events.length; seq += 1) {
          const e = record.events[seq]!;
          s.insertSettlement.run(id, record.slot, seq, e.settledAt, e.rawTime ?? null, e.rate, e.intervalHours, e.status, e.kind,
            plan.slot.index.get(e.evidence)!, e.timeMappingEvidence === undefined ? null : plan.slot.index.get(e.timeMappingEvidence)!);
        }
        s.upsertRead.run(id, record.slot, record.cutoff, record.observedAt, record.verifiedAt, record.body, JSON.stringify(plan.slot.strings));
      }
      db!.exec('COMMIT');
      const slots = new Map(before?.slots);
      for (const slot of gone) slots.delete(slot);
      for (const { record, plan } of plans) slots.set(record.slot, plan.slot);
      saved.set(key, { id, row, slots });
    } catch (err) {
      db!.exec('ROLLBACK');
      throw err;
    }
  }

  async function write(state: PersistedHistory): Promise<void> {
    if (!loaded) throw new Error('history-cache-not-loaded');
    if (!db) throw new Error('history-cache-unavailable');
    const keys = new Set([...state.snapshot.legs.keys(), ...state.progress.keys()]);
    let lastYield = Date.now();
    const pause = async () => { if (Date.now() - lastYield >= YIELD_EVERY_MS) { await yieldToLoop(); lastYield = Date.now(); } };
    for (const key of keys) {
      if (!db) throw new Error('history-cache-closed');
      const cached = state.snapshot.legs.get(key);
      const rotation = state.backfilled.get(key);
      writeLeg(key, encodeLeg(cached, state.progress.get(key)), legRow(cached, rotation), cached, rotation);
      await pause();
    }
    for (const [key, leg] of [...saved]) {
      if (keys.has(key)) continue;
      if (!db) throw new Error('history-cache-closed');
      db.exec('BEGIN');
      try {
        for (const statement of sql!.deleteLeg) statement.run(leg.id);
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      saved.delete(key);
      await pause();
    }
    if (!db) throw new Error('history-cache-closed');
    const { id, cutoff, publishedAt } = state.snapshot;
    sql!.setMeta.run(JSON.stringify({ id, cutoff, publishedAt, savedAt: Date.now() }));
  }

  return {
    load,
    save(state) {
      if (closed) return Promise.reject(new Error('history-cache-closed'));
      busy += 1;
      const run = chain.then(() => write(state));
      chain = run.catch(() => undefined).finally(() => {
        busy -= 1;
        if (closed && !busy) disconnect();
      });
      return run;
    },
    close() {
      closed = true;
      if (!busy) disconnect();
    },
  };
}

const legRow = (cached: CachedHistoryLeg | undefined, rotation: number | undefined) =>
  JSON.stringify([cached?.cutoff ?? null, cached?.backfill ?? null, rotation ?? null]);

type SlotPlan = { kind: 'same' | 'append' | 'rewrite'; from: number; slot: SavedSlot };

const sameEvent = (a: SettledFundingEvent, b: SettledFundingEvent) => a === b || (a.settledAt === b.settledAt
  && a.rate === b.rate && a.intervalHours === b.intervalHours && a.status === b.status && a.kind === b.kind
  && a.evidence === b.evidence && a.rawTime === b.rawTime && a.timeMappingEvidence === b.timeMappingEvidence);

/** Records only grow at the end or are replaced; a re-read with equal values writes nothing. */
function planSlot(before: SavedSlot | undefined, record: SlotRecord): SlotPlan {
  const events = record.events;
  const prefix = before !== undefined && before.events.length <= events.length
    && before.events.every((event, i) => sameEvent(event, events[i]!));
  if (prefix && before.events.length === events.length && before.body === record.body) return { kind: 'same', from: events.length, slot: before };
  const from = prefix ? before.events.length : 0;
  const strings = prefix ? [...before.strings] : [];
  const index = prefix ? new Map(before.index) : new Map<string, number>();
  for (let i = from; i < events.length; i += 1) {
    for (const text of [events[i]!.evidence, events[i]!.timeMappingEvidence]) {
      if (text !== undefined && !index.has(text)) { index.set(text, strings.length); strings.push(text); }
    }
  }
  return { kind: prefix ? 'append' : 'rewrite', from, slot: { body: record.body, strings, index, events: [...events] } };
}
