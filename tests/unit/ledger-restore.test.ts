/**
 * Restoring a pre-upgrade backup (ticket 20) is a ledger RESTORE, not a program
 * rollback: it is allowed only while the upgraded ledger holds nothing the
 * backup lacks, and it never deletes the ledger it replaces.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { restoreLedgerBackup } from '../../src/engine/ledger/restore';
import { LedgerRefusal } from '../../src/engine/ledger/version';
import { LEGACY_BOOT_SCHEMA, seedLegacyLedger } from '../helpers/legacy-ledger';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 9, 28, 1, 2, 3);

function upgraded(): { dir: string; file: string; backup: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-restore-'));
  dirs.push(dir);
  const file = path.join(dir, 'deals.sqlite');
  seedLegacyLedger(file);
  new Store(file, { now: NOW }).close();
  const name = fs.readdirSync(path.join(dir, 'ledger-backups')).find((f) => f.endsWith('.sqlite'))!;
  return { dir, file, backup: path.join(dir, 'ledger-backups', name) };
}

function refusal(fn: () => unknown): LedgerRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof LedgerRefusal) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

function alertCount(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT count(*) AS n FROM alert_log').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('restoreLedgerBackup', () => {
  it('refuses once the upgraded ledger has been written, and keeps every record', () => {
    const { file, backup } = upgraded();
    const store = new Store(file, { now: NOW });
    store.alert('warn', null, 'written after the upgrade', NOW + 1);
    store.close();

    const err = refusal(() => restoreLedgerBackup({ backupFile: backup, now: NOW + 2 }));
    expect(err.code).toBe('ledger-has-new-writes');
    expect(alertCount(file)).toBe(3);
    new Store(file, { now: NOW }).close(); // still the upgraded ledger
  });

  it('refuses while a server holds the ledger', () => {
    const { file, backup } = upgraded();
    const store = new Store(file, { now: NOW });
    try {
      expect(refusal(() => restoreLedgerBackup({ backupFile: backup, now: NOW })).code)
        .toBe('ledger-in-use');
    } finally {
      store.close();
    }
  });

  it('finds the ledger from the backup, and refuses without creating one when it is gone', () => {
    const { dir, file, backup } = upgraded();
    fs.renameSync(file, path.join(dir, 'moved.sqlite'));
    expect(refusal(() => restoreLedgerBackup({ backupFile: backup, now: NOW })).code).toBe('not-latest-backup');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses, rather than crashes, on a ledger that was never upgraded', () => {
    const { file, backup } = upgraded();
    fs.rmSync(file);
    seedLegacyLedger(file);
    expect(refusal(() => restoreLedgerBackup({ backupFile: backup, now: NOW })).code).toBe('not-latest-backup');
  });

  it('refuses a backup whose bytes no longer match its manifest', () => {
    const { file, backup } = upgraded();
    fs.appendFileSync(backup, 'x');
    expect(refusal(() => restoreLedgerBackup({ backupFile: backup, now: NOW })).code)
      .toBe('backup-unverified');
  });

  it('refuses a backup the latest migration did not take', () => {
    const { dir, file, backup } = upgraded();
    const stray = path.join(dir, 'ledger-backups', 'deals-v0-to-v1-19990101T000000Z.sqlite');
    fs.copyFileSync(backup, stray);
    fs.copyFileSync(`${backup}.json`, `${stray}.json`);
    expect(refusal(() => restoreLedgerBackup({ backupFile: stray, now: NOW })).code)
      .toBe('not-latest-backup');
  });

  it('restores an untouched upgrade and sets the replaced ledger aside', () => {
    const { dir, file, backup } = upgraded();
    const result = restoreLedgerBackup({ backupFile: backup, now: NOW + 5000 });

    expect(result.version).toBe(0);
    expect(result.replacedFile).toBe(`${file}.replaced-20261028T010208Z`);
    expect(alertCount(result.replacedFile)).toBe(2);
    expect(fs.existsSync(`${file}.restoring`)).toBe(false);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ledger-version.json'), 'utf8'))).toEqual({ version: 0 });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(file);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0);
      expect(() => db.exec(LEGACY_BOOT_SCHEMA)).not.toThrow();
      expect(db.prepare('SELECT client_id FROM orders ORDER BY leg').all())
        .toEqual([{ client_id: 'tOldDealA1' }, { client_id: 'tOldDealB1' }]);
    } finally {
      db.close();
    }
  });
});
