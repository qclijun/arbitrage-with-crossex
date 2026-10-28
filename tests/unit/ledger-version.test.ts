/**
 * Ledger version protocol (ticket 20): one integer version in the SQLite header,
 * refused when newer than this program, migrated forward one transaction at a
 * time behind a verified backup, and — from version 1 — fenced against every
 * pre-protocol release, which would otherwise boot on it and write.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { LEDGER_STEPS, LEDGER_VERSION, LedgerRefusal, prepareLedger } from '../../src/engine/ledger/version';
import { LEGACY_BOOT_SCHEMA, seedLegacyLedger } from '../helpers/legacy-ledger';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-version-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 9, 28, 1, 2, 3);
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const marker = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'ledger-version.json'), 'utf8')) as { version: number };
const backups = (dir: string) => {
  const d = path.join(dir, 'ledger-backups');
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};

function raw(file: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe('a fresh ledger', () => {
  it('starts at the current version with no backup, and records the version beside it', () => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    new Store(file, { now: NOW }).close();
    raw(file, (db) => expect(userVersion(db)).toBe(LEDGER_VERSION));
    expect(backups(dir)).toEqual([]);
    expect(marker(dir)).toEqual({ version: LEDGER_VERSION });
  });

  it('works in memory, where there is nothing to back up or mark', () => {
    const store = new Store(':memory:');
    store.alert('warn', null, 'hello', 1);
    expect(store.listAlerts().map((a) => a.message)).toEqual(['hello']);
    store.close();
  });
});

describe('upgrading a version-0 ledger', () => {
  it('backs up first, then keeps every historical fact byte for byte', () => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    seedLegacyLedger(file, { leaveWal: true });

    const store = new Store(file, { now: NOW });
    try {
      const pair = store.getPair('old-deal')!;
      expect(pair).toMatchObject({ mode: 'DONE', targetQty: '0.152', limitPrice: '2500', deadlineAt: 1770000000000, reportJson: '{"aFilled":"0.152"}' });
      const orders = store.listOrders('old-deal');
      expect(orders.map((o) => [o.clientId, o.venueOrderId, o.cumQty, o.avgFillPrice, o.state])).toEqual([
        ['tOldDealA1', 'V-77', '0.152', '2499.5', 'CLOSED'],
        ['tOldDealB1', 'V-78', '0.15', '2501.25', 'CLOSED'],
      ]);
      expect(store.listAlerts().map((a) => [a.message, a.ack])).toEqual([['residual 0.002', 1], ['legacy notice', 0]]);
      expect(store.listAlerts({ unackedOnly: true })).toHaveLength(1);
      // Autoincrement continues past the old ids instead of reusing them.
      store.alert('warn', null, 'after upgrade', NOW);
      expect(store.listAlerts().at(-1)!.id).toBe(3);
    } finally {
      store.close();
    }

    raw(file, (db) => {
      expect(userVersion(db)).toBe(LEDGER_VERSION);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('pair_created','pair_note') ORDER BY name").all())
        .toEqual([{ name: 'pair_created' }, { name: 'pair_note' }]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const row = db.prepare('SELECT * FROM ledger_migration').get() as Record<string, unknown>;
      expect(row).toMatchObject({ from_version: 0, to_version: LEDGER_VERSION, applied_at: NOW });
      expect(row.backup_file).toBe(backups(dir).find((f) => f.endsWith('.sqlite')));
    });
    expect(marker(dir)).toEqual({ version: LEDGER_VERSION });
  });

  it('writes a verified, owner-only backup of the version-0 ledger, WAL included', () => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    seedLegacyLedger(file, { leaveWal: true });
    new Store(file, { now: NOW }).close();

    const [backup, manifestFile] = backups(dir);
    expect(backup).toBe(`deals-v0-to-v${LEDGER_VERSION}-20261028T010203Z.sqlite`);
    expect(manifestFile).toBe(`${backup}.json`);
    const backupPath = path.join(dir, 'ledger-backups', backup);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'ledger-backups', manifestFile), 'utf8'));
    expect(manifest).toMatchObject({
      ledger: 'deals.sqlite', fromVersion: 0, toVersion: LEDGER_VERSION, createdAt: NOW,
      integrity: 'ok', rows: { alerts: 2, orders: 2, pair: 1 }, sha256: sha(backupPath),
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'ledger-backups')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, 'ledger-backups', manifestFile)).mode & 0o777).toBe(0o600);
    }
    raw(backupPath, (db) => {
      expect(userVersion(db)).toBe(0);
      expect(db.prepare('SELECT client_id, cum_qty FROM orders ORDER BY seq, leg').all())
        .toEqual([{ client_id: 'tOldDealA1', cum_qty: '0.152' }, { client_id: 'tOldDealB1', cum_qty: '0.15' }]);
      // The backup is a version-0 ledger an old program can still boot on.
      expect(() => db.exec(LEGACY_BOOT_SCHEMA)).not.toThrow();
    });
  });

  it('fences every pre-protocol release out at boot, before it could write or trade', () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    seedLegacyLedger(file);
    new Store(file, { now: NOW }).close();
    raw(file, (db) => {
      const before = db.prepare('SELECT count(*) AS n FROM alert_log').get();
      // Exactly what `new Store()` of releases since 6f0f051 runs first.
      expect(() => db.exec(LEGACY_BOOT_SCHEMA)).toThrow(/already an index named alerts/);
      expect(db.prepare('SELECT count(*) AS n FROM alert_log').get()).toEqual(before);
      expect(userVersion(db)).toBe(LEDGER_VERSION);
    });
  });

  it('reopens without migrating or backing up again', () => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    seedLegacyLedger(file);
    new Store(file, { now: NOW }).close();
    const first = backups(dir);
    const again = new Store(file, { now: NOW + 60_000 });
    expect(again.getPair('old-deal')!.mode).toBe('DONE');
    again.close();
    expect(backups(dir)).toEqual(first);
  });
});

describe('refusals happen before any write', () => {
  it.each([
    ['an executing deal', { mode: 'OPENING' }, 'old-deal'],
    ['a halted deal', { mode: 'HALTED' }, 'old-deal'],
    ['a live order', { bState: 'OPEN' }, 'tOldDealB1'],
    ['an unresolved create', { bState: 'PENDING' }, 'tOldDealB1'],
    ['a quarantined order', { quarantined: 'weird-status' }, 'tOldDealB1'],
  ])('leaves a version-0 ledger with %s untouched for the old program', (_name, opts, named) => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    seedLegacyLedger(file, opts);
    const before = sha(file);
    let error: unknown;
    try {
      new Store(file, { now: NOW });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(LedgerRefusal);
    expect((error as LedgerRefusal).code).toBe('not-quiescent');
    expect((error as Error).message).toContain(named);
    expect(sha(file)).toBe(before);
    expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
    expect(backups(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'ledger-version.json'))).toBe(false);
    raw(file, (db) => expect(() => db.exec(LEGACY_BOOT_SCHEMA)).not.toThrow());
  });

  it('refuses a ledger from a newer program without touching it or its marker', () => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    new Store(file, { now: NOW }).close();
    raw(file, (db) => db.exec(`PRAGMA user_version = ${LEDGER_VERSION + 1}`));
    fs.writeFileSync(path.join(dir, 'ledger-version.json'), JSON.stringify({ version: LEDGER_VERSION + 1 }));
    const before = sha(file);
    expect(() => new Store(file, { now: NOW })).toThrow(LedgerRefusal);
    try {
      new Store(file, { now: NOW });
    } catch (err) {
      expect((err as LedgerRefusal).code).toBe('future-version');
    }
    expect(sha(file)).toBe(before);
    expect(marker(dir)).toEqual({ version: LEDGER_VERSION + 1 });
  });
});

describe('a failed migration leaves no half-upgraded ledger', () => {
  it('rolls every step back, keeps the backup, and retries cleanly', () => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    seedLegacyLedger(file);
    raw(file, (db) => {
      // A pre-'best' column set: the upgrade must add these inside its transaction.
      db.exec('ALTER TABLE pair DROP COLUMN book_outage_started_at');
    });
    const db = new DatabaseSync(file);
    const interrupted = [{
      to: 1,
      quiescent: true,
      apply: (inner: DatabaseSync) => {
        inner.exec(`ALTER TABLE pair ADD COLUMN book_outage_started_at INTEGER NOT NULL DEFAULT 0`);
        inner.exec('ALTER TABLE alerts RENAME TO alert_log');
        throw new Error('power cut');
      },
    }];
    expect(() => prepareLedger(db, { file, now: NOW, steps: interrupted })).toThrow('power cut');
    expect(userVersion(db)).toBe(0);
    expect((db.prepare('PRAGMA table_info(pair)').all() as { name: string }[]).some((c) => c.name === 'book_outage_started_at')).toBe(false);
    expect(db.prepare("SELECT type FROM sqlite_master WHERE name = 'alerts'").get()).toEqual({ type: 'table' });
    db.close();
    expect(marker(dir)).toEqual({ version: 0 });
    expect(backups(dir)).toHaveLength(2);

    const store = new Store(file, { now: NOW + 1000 });
    expect(store.getPair('old-deal')!.bookOutageStartedAt).toBe(0);
    store.close();
    expect(marker(dir)).toEqual({ version: LEDGER_VERSION });
  });
});

describe('a killed migration leaves no half-upgraded ledger', () => {
  it('reopens at version 0 after a hard kill mid-transaction, then upgrades', () => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    seedLegacyLedger(file);
    const version = fileURLToPath(new URL('../../src/engine/ledger/version.ts', import.meta.url));
    const script = path.join(dir, 'kill.ts');
    fs.writeFileSync(script, [
      "import { DatabaseSync } from 'node:sqlite';",
      `import { LEDGER_STEPS, prepareLedger } from ${JSON.stringify(version)};`,
      `const db = new DatabaseSync(${JSON.stringify(file)});`,
      "db.exec('PRAGMA locking_mode = EXCLUSIVE');",
      `prepareLedger(db, { file: ${JSON.stringify(file)}, now: ${NOW}, steps: [{ ...LEDGER_STEPS[0], apply: (inner) => {`,
      '  LEDGER_STEPS[0].apply(inner);',
      "  process.kill(process.pid, 'SIGKILL');",
      '} }] });',
    ].join('\n'));
    const repo = fileURLToPath(new URL('../..', import.meta.url));
    const run = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: repo, encoding: 'utf8' });
    expect(run.signal).toBe('SIGKILL');
    // Marked before the commit: the installers now refuse a rollback that is
    // still safe, never the reverse.
    expect(marker(dir)).toEqual({ version: 1 });
    raw(file, (db) => {
      expect(userVersion(db)).toBe(0);
      expect(db.prepare("SELECT type FROM sqlite_master WHERE name = 'alerts'").get()).toEqual({ type: 'table' });
      expect(() => db.exec(LEGACY_BOOT_SCHEMA)).not.toThrow();
    });
    const store = new Store(file, { now: NOW + 1000 });
    expect(store.listOrders('old-deal')).toHaveLength(2);
    store.close();
    raw(file, (db) => expect(userVersion(db)).toBe(LEDGER_VERSION));
  });
});

describe('the open ledger is held exclusively', () => {
  it('keeps every other connection from writing between the check, the backup and the migration', () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    seedLegacyLedger(file);
    const store = new Store(file, { now: NOW });
    try {
      const other = new DatabaseSync(file);
      try {
        expect(() => other.exec("INSERT INTO alert_log (ts, level, message) VALUES (1, 'warn', 'sneak')")).toThrow(/locked/);
      } finally {
        other.close();
      }
    } finally {
      store.close();
    }
  });
});

describe('additive steps', () => {
  it('upgrade a version-1 ledger whose deal is still executing, without refusing or touching the deal', () => {
    const dir = tempDir();
    const file = path.join(dir, 'deals.sqlite');
    seedLegacyLedger(file, { mode: 'OPENING', bState: 'OPEN' });
    raw(file, (db) => {
      // Reach version 1 the way a version-1 program did (it ran with no deals).
      db.prepare("UPDATE pair SET mode = 'DONE'").run();
      db.prepare("UPDATE orders SET state = 'CLOSED'").run();
      prepareLedger(db, { file, now: NOW, steps: LEDGER_STEPS.filter((s) => s.to === 1) });
      db.prepare("UPDATE pair SET mode = 'OPENING'").run();
      db.prepare("UPDATE orders SET state = 'OPEN' WHERE leg = 'B'").run();
    });
    const store = new Store(file, { now: NOW + 1 });
    try {
      expect(store.getPair('old-deal')).toMatchObject({ mode: 'OPENING', purpose: null, purposeContext: null });
      expect(store.listOrders('old-deal').map((o) => o.state)).toEqual(['CLOSED', 'OPEN']);
    } finally {
      store.close();
    }
    raw(file, (db) => expect(userVersion(db)).toBe(LEDGER_VERSION));
    expect(backups(dir).filter((f) => f.endsWith('.sqlite'))).toHaveLength(2);
  });
});
