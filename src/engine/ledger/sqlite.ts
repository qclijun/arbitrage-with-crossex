/** Small node:sqlite helpers shared by the ledger store and its tools. */
import type { DatabaseSync } from 'node:sqlite';

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

export function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** SQLITE_BUSY / SQLITE_LOCKED, or a message saying so: another connection
 * holds the ledger. */
export function isSqliteLockError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const sqliteError = error as { errcode?: unknown; errstr?: unknown; message?: unknown };
  const details = [sqliteError.errstr, sqliteError.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return (
    sqliteError.errcode === 5 ||
    sqliteError.errcode === 6 ||
    /database.*\b(?:locked|busy)\b/i.test(details)
  );
}

/** Take the write lock now and, under `locking_mode = EXCLUSIVE`, keep it
 * until close. A read alone does not exclude other writers in WAL mode; an
 * empty write transaction does, and writes nothing. */
export function claimExclusive(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  db.exec('COMMIT');
}

let savepoints = 0;

/** Run `fn` atomically, whether or not a transaction is already open — a
 * savepoint nests where a second BEGIN would throw. */
export function inSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  const name = `sp${savepoints++}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const value = fn();
    db.exec(`RELEASE ${name}`);
    return value;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}
