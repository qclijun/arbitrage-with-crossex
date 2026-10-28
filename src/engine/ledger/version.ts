/**
 * Ledger version protocol (ticket 20).
 *
 * The SQLite header's `user_version` is the ledger version. A program opens a
 * ledger only if it knows that version; it migrates an older one forward by
 * registered steps, all pending steps in ONE transaction that also bumps the
 * version, so a failure or crash leaves the previous version intact. Before
 * any step it refuses — without writing — a ledger whose executions have not
 * converged when a step needs that, then takes a verified backup.
 *
 * Feature tickets own their tables and add steps here; they do not migrate on
 * their own. A step that changes how existing rows are read must also fence
 * out every program that would misread them: the next program to open the
 * ledger may be an older one, and the only code guaranteed to run there is
 * the code that release already shipped.
 */
import type { DatabaseSync } from 'node:sqlite';
import { backupLedger, ledgerFingerprint, type BackupManifest } from './backup';
import { LEGACY_SCHEMA, normalizeLegacyTables } from './legacy';
import { writeLedgerMarker } from './marker';
import { SLICE_SCHEMA } from './slice-schema';
import { hasTable, userVersion } from './sqlite';

export type LedgerRefusalCode =
  | 'future-version'
  | 'not-quiescent'
  | 'ledger-in-use'
  | 'backup-unverified'
  | 'not-latest-backup'
  | 'ledger-has-new-writes';

/** A deliberate "no" that changed nothing — distinct from a failure. */
export class LedgerRefusal extends Error {
  constructor(readonly code: LedgerRefusalCode, message: string) {
    super(message);
    this.name = 'LedgerRefusal';
  }
}

export interface LedgerStep {
  /** The version this step produces; steps are listed in ascending order. */
  to: number;
  /** True when executions must have converged first: no unfinished deal and
   * no live, unresolved or quarantined order. */
  quiescent: boolean;
  apply(db: DatabaseSync): void;
}

export const LEDGER_STEPS: readonly LedgerStep[] = [
  {
    // Version 1 fences out every pre-protocol release. Each of them runs
    // `CREATE TABLE IF NOT EXISTS alerts` in its Store constructor, before its
    // loop or HTTP listener can start; with the name held by an index that
    // statement fails, so an old program cannot boot on this ledger at all —
    // let alone write it or touch a venue. The index also serves listAlerts.
    to: 1,
    quiescent: true,
    apply: (db) => {
      normalizeLegacyTables(db);
      db.exec('ALTER TABLE alerts RENAME TO alert_log');
      db.exec('CREATE INDEX alerts ON alert_log(ack, id)');
    },
  },
  {
    // Version 2 (ticket 19): each deal's declared purpose and its context, and
    // the admission switch (engine/admission.ts). Additive: existing deals keep
    // running and read purpose NULL — "created before purposes existed".
    to: 2,
    quiescent: false,
    apply: (db) => {
      db.exec('ALTER TABLE pair ADD COLUMN purpose TEXT');
      db.exec('ALTER TABLE pair ADD COLUMN purpose_context TEXT');
      db.exec(`CREATE TABLE admission_switch (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        open INTEGER NOT NULL CHECK (open IN (0, 1)),
        generation INTEGER NOT NULL,
        enabled_version TEXT,
        ledger_version INTEGER,
        changed_at INTEGER NOT NULL
      )`);
    },
  },
  {
    // Version 3 (ticket 15): the strategy slice ledger (engine/slices.ts).
    // Additive: every existing position and deal stays unattributed.
    to: 3,
    quiescent: false,
    apply: (db) => db.exec(SLICE_SCHEMA),
  },
];

export const LEDGER_VERSION = LEDGER_STEPS.at(-1)!.to;

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS ledger_migration (
  to_version INTEGER PRIMARY KEY,
  from_version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  backup_file TEXT,
  backup_sha256 TEXT,
  content_sha256 TEXT NOT NULL
);`;

function assertQuiescent(db: DatabaseSync): void {
  const open: string[] = [];
  if (hasTable(db, 'pair')) {
    for (const r of db.prepare("SELECT id, mode FROM pair WHERE mode != 'DONE' ORDER BY created_at").all() as { id: string; mode: string }[]) {
      open.push(`deal ${r.id} (${r.mode})`);
    }
  }
  if (hasTable(db, 'orders')) {
    const rows = db.prepare(
      "SELECT client_id, state, quarantined_status FROM orders WHERE state IN ('PENDING','OPEN') OR quarantined_status IS NOT NULL ORDER BY created_at",
    ).all() as { client_id: string; state: string; quarantined_status: string | null }[];
    for (const r of rows) open.push(`order ${r.client_id} (${r.quarantined_status ? `quarantined: ${r.quarantined_status}` : r.state})`);
  }
  if (open.length) {
    throw new LedgerRefusal(
      'not-quiescent',
      `the trade ledger needs a one-way upgrade, but executions have not finished: ${open.join('; ')}. ` +
        'Keep the previous version running until every deal is done and no order is unresolved, then update again. Nothing was changed.',
    );
  }
}

/** Open-time version gate and migration; see the module comment. `file` is
 * null for an in-memory ledger, which has nothing to back up or mark. */
export function prepareLedger(
  db: DatabaseSync,
  opts: { file: string | null; now: number; steps?: readonly LedgerStep[] },
): void {
  const steps = opts.steps ?? LEDGER_STEPS;
  const target = steps.at(-1)?.to ?? 0;
  const from = userVersion(db);
  if (from > target) {
    throw new LedgerRefusal(
      'future-version',
      `the trade ledger is version ${from}, newer than this program supports (${target}). ` +
        'It was written by a newer version: install that version again. Nothing was changed.',
    );
  }
  const pending = steps.filter((s) => s.to > from);
  if (!pending.length) {
    writeLedgerMarker(opts.file, from);
    return;
  }
  const fresh = from === 0 && !hasTable(db, 'pair');
  if (!fresh && pending.some((s) => s.quiescent)) assertQuiescent(db);
  const backup: BackupManifest | null = !fresh && opts.file
    ? backupLedger(db, opts.file, { from, to: target, now: opts.now })
    : null;
  // Marked BEFORE the commit: a crash in between leaves installers refusing a
  // rollback that would have been safe, never allowing one that is not.
  writeLedgerMarker(opts.file, target);
  db.exec('PRAGMA foreign_keys = OFF'); // a no-op inside a transaction, so toggled outside
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (from === 0) db.exec(LEGACY_SCHEMA);
      for (const step of pending) step.apply(db);
      db.exec(MIGRATION_TABLE);
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error(`ledger migration left ${violations.length} foreign-key violation(s)`);
      db.prepare(
        `INSERT INTO ledger_migration (to_version, from_version, applied_at, backup_file, backup_sha256, content_sha256)
         VALUES (?,?,?,?,?,?)`,
      ).run(target, from, opts.now, backup?.file ?? null, backup?.sha256 ?? null, ledgerFingerprint(db));
      db.exec(`PRAGMA user_version = ${target}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* SQLite already rolled back */
      }
      writeLedgerMarker(opts.file, from);
      throw err;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
