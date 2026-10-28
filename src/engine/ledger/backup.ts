/**
 * Ledger backups and content fingerprints (ticket 20).
 *
 * A backup is `VACUUM INTO` from the live connection: one consistent snapshot
 * that includes committed WAL content, written beside the ledger, verified by
 * reopening it, then hashed. Backups carry trade history, so the directory and
 * files are owner-only; on Windows they inherit the data directory's ACL.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BACKUP_DIR = 'ledger-backups';

export interface BackupManifest {
  ledger: string;
  file: string;
  fromVersion: number;
  toVersion: number;
  createdAt: number;
  bytes: number;
  sha256: string;
  integrity: 'ok';
  rows: Record<string, number>;
}

/** `20261028T010203Z` — sortable and safe in a file name on every platform. */
export function stamp(now: number): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** User tables in name order; `sqlite_%` bookkeeping is SQLite's, not ours. */
function tables(db: DatabaseSync, except: readonly string[] = []): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map((t) => t.name).filter((name) => !except.includes(name));
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function rowCounts(db: DatabaseSync): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const name of tables(db)) {
    rows[name] = (db.prepare(`SELECT count(*) AS n FROM ${quoted(name)}`).get() as { n: number }).n;
  }
  return rows;
}

/** A hash of every row of every ledger table except the migration journal —
 * equal fingerprints mean nothing was written in between. Rows are compared as
 * a set, so it needs no ordering column. */
export function ledgerFingerprint(db: DatabaseSync): string {
  const hash = crypto.createHash('sha256');
  for (const name of tables(db, ['ledger_migration'])) {
    const rows = (db.prepare(`SELECT * FROM ${quoted(name)}`).all() as unknown[]).map((r) => JSON.stringify(r)).sort();
    hash.update(JSON.stringify([name, rows]));
  }
  return hash.digest('hex');
}

function writeOwnerOnly(file: string, data: string | Buffer): void {
  const tmp = `${file}.partial`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  syncFile(tmp);
  fs.renameSync(tmp, file);
}

export function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeJsonOwnerOnly(file: string, value: unknown): void {
  writeOwnerOnly(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Snapshot the ledger behind `db` before migrating it from `from` to `to`.
 * Throws — and the caller migrates nothing — unless the snapshot reopens with
 * a clean integrity check, the same version and the same row counts. */
export function backupLedger(
  db: DatabaseSync,
  ledgerFile: string,
  opts: { from: number; to: number; now: number },
): BackupManifest {
  const dir = path.join(path.dirname(ledgerFile), BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const base = `${path.basename(ledgerFile, '.sqlite')}-v${opts.from}-to-v${opts.to}-${stamp(opts.now)}`;
  let name = `${base}.sqlite`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n += 1) name = `${base}-${n}.sqlite`;
  const file = path.join(dir, name);
  const tmp = `${file}.partial`;
  fs.rmSync(tmp, { force: true });
  db.prepare('VACUUM INTO ?').run(tmp);
  fs.chmodSync(tmp, 0o600);

  const rows = rowCounts(db);
  const copy = new DatabaseSync(tmp, { readOnly: true });
  try {
    const integrity = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (integrity !== 'ok') throw new Error(`ledger backup failed its integrity check: ${integrity}`);
    if (userVersion(copy) !== opts.from) throw new Error('ledger backup does not carry the ledger version');
    if (JSON.stringify(rowCounts(copy)) !== JSON.stringify(rows)) throw new Error('ledger backup row counts differ from the ledger');
  } finally {
    copy.close();
  }
  syncFile(tmp);
  fs.renameSync(tmp, file);

  const manifest: BackupManifest = {
    ledger: path.basename(ledgerFile),
    file: name,
    fromVersion: opts.from,
    toVersion: opts.to,
    createdAt: opts.now,
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
    integrity: 'ok',
    rows,
  };
  writeJsonOwnerOnly(`${file}.json`, manifest);
  return manifest;
}
