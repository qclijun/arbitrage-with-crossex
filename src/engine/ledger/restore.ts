/**
 * Restore the backup a migration took (ticket 20). This is a ledger restore,
 * not a program rollback: once the upgraded ledger holds anything the backup
 * lacks — a deal, a fill, an alert — restoring would erase it, so it is
 * refused and the way forward is the newer program. The replaced ledger is
 * always set aside, never deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ledgerFingerprint, sha256File, stamp, syncFile, userVersion, type BackupManifest } from './backup';
import { LedgerRefusal, writeLedgerMarker } from './version';

export interface RestoreResult {
  /** Version of the restored ledger. */
  version: number;
  /** Where the ledger it replaced now lives. */
  replacedFile: string;
}

interface MigrationRow {
  to_version: number;
  backup_file: string | null;
  backup_sha256: string | null;
  content_sha256: string;
}

function readManifest(backupFile: string): BackupManifest {
  try {
    const manifest = JSON.parse(fs.readFileSync(`${backupFile}.json`, 'utf8')) as BackupManifest;
    if (manifest.sha256 === sha256File(backupFile) && Number.isInteger(manifest.fromVersion)) return manifest;
  } catch {
    /* refused below */
  }
  throw new LedgerRefusal('backup-unverified', `${backupFile} does not match its manifest; it was not restored.`);
}

function isLockError(err: unknown): boolean {
  const e = err as { errcode?: unknown; message?: unknown };
  return e?.errcode === 5 || e?.errcode === 6 || /locked|busy/i.test(String(e?.message));
}

/** Check, under the ledger's own lock, that `backupFile` is the latest
 * migration's backup and nothing was written since that migration. */
function assertRestorable(ledgerFile: string, backupFile: string, manifest: BackupManifest): void {
  const db = new DatabaseSync(ledgerFile);
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (!isLockError(err)) throw err;
      throw new LedgerRefusal('ledger-in-use', 'the trade ledger is open in a running server; stop it first. Nothing was changed.');
    }
    const latest = db.prepare('SELECT * FROM ledger_migration ORDER BY to_version DESC LIMIT 1').get() as unknown as MigrationRow | undefined;
    if (!latest || latest.to_version !== userVersion(db) || latest.backup_file !== path.basename(backupFile) || latest.backup_sha256 !== manifest.sha256) {
      throw new LedgerRefusal('not-latest-backup', `${path.basename(backupFile)} is not the backup the latest ledger upgrade took. Nothing was changed.`);
    }
    if (ledgerFingerprint(db) !== latest.content_sha256) {
      throw new LedgerRefusal(
        'ledger-has-new-writes',
        'the trade ledger was written after its upgrade; restoring the backup would erase those records. Run the newer program instead. Nothing was changed.',
      );
    }
    db.exec('ROLLBACK');
  } finally {
    db.close(); // the last connection closing checkpoints the WAL into the file
  }
}

export function restoreLedgerBackup(opts: { ledgerFile: string; backupFile: string; now: number }): RestoreResult {
  const manifest = readManifest(opts.backupFile);
  assertRestorable(opts.ledgerFile, opts.backupFile, manifest);

  const replacedFile = `${opts.ledgerFile}.replaced-${stamp(opts.now)}`;
  fs.renameSync(opts.ledgerFile, replacedFile);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${opts.ledgerFile}${suffix}`)) fs.renameSync(`${opts.ledgerFile}${suffix}`, `${replacedFile}${suffix}`);
  }
  const tmp = `${opts.ledgerFile}.restoring`;
  fs.copyFileSync(opts.backupFile, tmp);
  fs.chmodSync(tmp, 0o600);
  syncFile(tmp);
  fs.renameSync(tmp, opts.ledgerFile);
  writeLedgerMarker(opts.ledgerFile, manifest.fromVersion);
  return { version: manifest.fromVersion, replacedFile };
}
