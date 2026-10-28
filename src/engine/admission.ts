/**
 * The persistent admission switch (ticket 19) for NEW funding-opportunity
 * opens. It never touches an accepted execution: closing it stops new
 * acceptances only — no deal is stopped, no loop paused, no venue called.
 *
 * Closed unless a row says open AND it was enabled by this exact program and
 * ledger version: first run, an upgrade, or a program that cannot name its
 * own version all read closed. Every open or close moves the generation; an
 * acceptance names the generation its preview was minted under and is
 * admitted only inside the same transaction that finds the switch open at
 * that generation. A reopen therefore never revives an older preview.
 * The table is created by ledger step 2 (ledger/version.ts).
 */
import type { DatabaseSync } from 'node:sqlite';
import { LEDGER_VERSION } from './ledger/version';

export type AdmissionReason = 'open' | 'never-enabled' | 'closed' | 'version-changed' | 'version-unknown';

export interface AdmissionState {
  open: boolean;
  generation: number;
  reason: AdmissionReason;
  changedAt: number | null;
  /** Program version that last enabled admission. */
  enabledVersion: string | null;
}

export type Admitted<T> = { ok: true; value: T } | { ok: false; state: AdmissionState };

interface SwitchRow {
  open: number;
  generation: number;
  enabled_version: string | null;
  ledger_version: number | null;
  changed_at: number;
}

export class AdmissionSwitch {
  constructor(
    private readonly db: DatabaseSync,
    /** This program's release version; null when it cannot tell (a source
     * checkout without version.json), which keeps admission closed. */
    private readonly programVersion: string | null,
  ) {}

  read(): AdmissionState {
    const row = this.db.prepare('SELECT * FROM admission_switch WHERE id = 1').get() as unknown as SwitchRow | undefined;
    const base = {
      generation: row?.generation ?? 0,
      changedAt: row?.changed_at ?? null,
      enabledVersion: row?.enabled_version ?? null,
    };
    if (this.programVersion === null) return { ...base, open: false, reason: 'version-unknown' };
    if (!row) return { ...base, open: false, reason: 'never-enabled' };
    if (!row.open) return { ...base, open: false, reason: 'closed' };
    if (row.enabled_version !== this.programVersion || row.ledger_version !== LEDGER_VERSION) {
      return { ...base, open: false, reason: 'version-changed' };
    }
    return { ...base, open: true, reason: 'open' };
  }

  enable(now: number): AdmissionState {
    if (this.programVersion === null) {
      throw new Error('admission cannot be enabled: this program does not know its own version');
    }
    return this.write(true, now);
  }

  disable(now: number): AdmissionState {
    return this.write(false, now);
  }

  /** Run `write` — the acceptance — atomically with the check that admission
   * is open at `generation`. A throw rolls the acceptance back. `write` runs
   * inside this transaction, so it must not open one of its own (a Store
   * method that BEGINs would throw). */
  admit<T>(generation: number, write: () => T): Admitted<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      if (!state.open || state.generation !== generation) {
        this.db.exec('ROLLBACK');
        return { ok: false, state };
      }
      const value = write();
      this.db.exec('COMMIT');
      return { ok: true, value };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  private write(open: boolean, now: number): AdmissionState {
    this.db.prepare(
      `INSERT INTO admission_switch (id, open, generation, enabled_version, ledger_version, changed_at)
       VALUES (1, ?, 1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         open = excluded.open,
         generation = admission_switch.generation + 1,
         enabled_version = CASE WHEN excluded.open = 1 THEN excluded.enabled_version ELSE admission_switch.enabled_version END,
         ledger_version = CASE WHEN excluded.open = 1 THEN excluded.ledger_version ELSE admission_switch.ledger_version END,
         changed_at = excluded.changed_at`,
    ).run(open ? 1 : 0, open ? this.programVersion : null, open ? LEDGER_VERSION : null, now);
    return this.read();
  }
}
