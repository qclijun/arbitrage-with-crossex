/**
 * Restore the backup a migration took (ticket 20). This is a ledger restore,
 * not a program rollback: once the upgraded ledger holds anything the backup
 * lacks — a deal, a fill, an alert — restoring would erase it, so it is
 * refused and the way forward is the newer program. The replaced ledger is
 * always kept, never deleted.
 *
 * The ledger is the one the backup was taken from (`<data>/ledger-backups/`
 * sits beside it), so a tool run from any directory cannot pick another one.
 * The swap is one atomic rename made while this process holds the ledger's
 * lock: at every instant the ledger file is either the old ledger or the
 * whole backup, and no server can open it in between.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ledgerFingerprint, sha256File, stamp, syncFile, type BackupManifest } from './backup';
import { writeLedgerMarker } from './marker';
import { claimExclusive, hasTable, isSqliteLockError, userVersion } from './sqlite';
import { LedgerRefusal } from './version';

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
    if (
      manifest.sha256 === sha256File(backupFile) &&
      Number.isInteger(manifest.fromVersion) &&
      typeof manifest.ledger === 'string' &&
      manifest.ledger === path.basename(manifest.ledger)
    ) {
      return manifest;
    }
  } catch {
    /* refused below */
  }
  throw new LedgerRefusal('backup-unverified', `${backupFile} does not match its manifest; it was not restored.`);
}

const notLatest = (backupFile: string, why: string): LedgerRefusal =>
  new LedgerRefusal('not-latest-backup', `${path.basename(backupFile)} is not the backup the latest ledger upgrade took (${why}). Nothing was changed.`);

/** Under the ledger's own lock: is `backupFile` the latest migration's backup,
 * with nothing written since that migration? */
function assertRestorable(db: DatabaseSync, backupFile: string, manifest: BackupManifest): void {
  try {
    claimExclusive(db);
  } catch (err) {
    if (!isSqliteLockError(err)) throw err;
    throw new LedgerRefusal('ledger-in-use', 'the trade ledger is open in a running server; stop it first. Nothing was changed.');
  }
  if (!hasTable(db, 'ledger_migration')) throw notLatest(backupFile, 'the ledger was never upgraded');
  const latest = db.prepare('SELECT * FROM ledger_migration ORDER BY to_version DESC LIMIT 1').get() as unknown as MigrationRow | undefined;
  if (!latest || latest.to_version !== userVersion(db)) throw notLatest(backupFile, 'no upgrade is recorded for this version');
  if (latest.backup_file !== path.basename(backupFile) || latest.backup_sha256 !== manifest.sha256) {
    throw notLatest(backupFile, `that upgrade took ${latest.backup_file ?? 'no backup'}`);
  }
  if (ledgerFingerprint(db) !== latest.content_sha256) {
    throw new LedgerRefusal(
      'ledger-has-new-writes',
      'the trade ledger was written after its upgrade; restoring the backup would erase those records. Run the newer program instead. Nothing was changed.',
    );
  }
}

/** Platforms that cannot rename over an open file (Windows) report it as one
 * of these; there the lock is released first and the swap is still atomic. */
const RENAME_BLOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function restoreLedgerBackup(opts: { backupFile: string; now: number }): RestoreResult {
  const manifest = readManifest(opts.backupFile);
  const ledgerFile = path.join(path.dirname(path.dirname(opts.backupFile)), manifest.ledger);
  // Opening a missing path would create an empty ledger; refuse instead.
  if (!fs.existsSync(ledgerFile)) throw notLatest(opts.backupFile, `there is no ledger at ${ledgerFile}`);

  const replacedFile = `${ledgerFile}.replaced-${stamp(opts.now)}`;
  const restoring = `${ledgerFile}.restoring`;
  const db = new DatabaseSync(ledgerFile);
  let open = true;
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    assertRestorable(db, opts.backupFile, manifest);
    if (fs.existsSync(replacedFile)) throw new Error(`${replacedFile} already exists; nothing was changed`);
    // The replaced ledger is kept as one consistent file, WAL folded in.
    db.prepare('VACUUM INTO ?').run(replacedFile);
    fs.chmodSync(replacedFile, 0o600);
    syncFile(replacedFile);
    fs.rmSync(restoring, { force: true });
    fs.copyFileSync(opts.backupFile, restoring);
    fs.chmodSync(restoring, 0o600);
    syncFile(restoring);
    // Leave WAL so closing this connection later cannot touch a `-wal` file
    // that by then belongs to whoever opens the restored ledger.
    db.exec('PRAGMA journal_mode = DELETE');
    try {
      fs.renameSync(restoring, ledgerFile);
    } catch (err) {
      if (!RENAME_BLOCKED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      db.close();
      open = false;
      fs.renameSync(restoring, ledgerFile);
    }
  } catch (err) {
    fs.rmSync(restoring, { force: true });
    throw err;
  } finally {
    if (open) db.close();
  }
  writeLedgerMarker(ledgerFile, manifest.fromVersion);
  return { version: manifest.fromVersion, replacedFile };
}
