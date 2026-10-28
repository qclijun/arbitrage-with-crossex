/**
 * The persistent admission switch (ticket 19): closed until explicitly
 * enabled, closed again after any program or ledger version change, and every
 * open/close moves a generation that an acceptance must still match — so a
 * preview minted before a close can never be accepted after a reopen.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { LEDGER_VERSION } from '../../src/engine/ledger/version';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const file = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-'));
  dirs.push(d);
  return path.join(d, 'deals.sqlite');
};

describe('admission switch', () => {
  it('is closed on a new ledger and stays closed across restarts until enabled', () => {
    const f = file();
    let store = new Store(f, { programVersion: '1.8.0' });
    expect(store.admission.read()).toMatchObject({ open: false, generation: 0, reason: 'never-enabled' });
    store.close();
    store = new Store(f, { programVersion: '1.8.0' });
    expect(store.admission.read().open).toBe(false);
    store.close();
  });

  it('opens and closes durably, moving the generation every time', () => {
    const f = file();
    let store = new Store(f, { programVersion: '1.8.0' });
    expect(store.admission.enable(10)).toMatchObject({ open: true, generation: 1, reason: 'open', changedAt: 10, enabledVersion: '1.8.0' });
    store.close();
    store = new Store(f, { programVersion: '1.8.0' });
    expect(store.admission.read()).toMatchObject({ open: true, generation: 1 });
    expect(store.admission.disable(20)).toMatchObject({ open: false, generation: 2, reason: 'closed' });
    expect(store.admission.enable(30).generation).toBe(3);
    store.close();
  });

  it('reads closed after the program version changes, and the old generation stays dead', () => {
    const f = file();
    let store = new Store(f, { programVersion: '1.8.0' });
    const { generation } = store.admission.enable(10);
    store.close();
    store = new Store(f, { programVersion: '1.8.1' });
    expect(store.admission.read()).toMatchObject({ open: false, reason: 'version-changed', generation });
    expect(store.admission.admit(generation, () => 'accepted')).toMatchObject({ ok: false });
    expect(store.admission.enable(20).generation).toBe(generation + 1);
    store.close();
  });

  it('reads closed after the ledger version recorded at enabling no longer matches', () => {
    const f = file();
    let store = new Store(f, { programVersion: '1.8.0' });
    store.admission.enable(10);
    store.close();
    const db = new DatabaseSync(f);
    db.prepare('UPDATE admission_switch SET ledger_version = ?').run(LEDGER_VERSION - 1);
    db.close();
    store = new Store(f, { programVersion: '1.8.0' });
    expect(store.admission.read()).toMatchObject({ open: false, reason: 'version-changed' });
    store.close();
  });

  it('cannot be enabled by a program that does not know its own version', () => {
    const store = new Store(':memory:');
    expect(store.admission.read()).toMatchObject({ open: false, reason: 'version-unknown' });
    expect(() => store.admission.enable(1)).toThrow(/version/);
    expect(store.admission.read().generation).toBe(0);
    store.close();
  });

  it('admits a write only while open at the same generation, atomically', () => {
    const store = new Store(':memory:', { programVersion: '1.8.0' });
    const g1 = store.admission.enable(1).generation;
    expect(store.admission.admit(g1, () => 'first')).toEqual({ ok: true, value: 'first' });

    store.admission.disable(2);
    let ran = false;
    const late = store.admission.admit(g1, () => {
      ran = true;
    });
    expect(late).toMatchObject({ ok: false, state: { open: false, reason: 'closed' } });
    expect(ran).toBe(false);

    // Reopening does not revive what was minted before the close.
    store.admission.enable(3);
    expect(store.admission.admit(g1, () => 'revived')).toMatchObject({ ok: false, state: { open: true } });
    store.close();
  });

  it('rolls back the admitted write when it throws, leaving the switch unchanged', () => {
    const store = new Store(':memory:', { programVersion: '1.8.0' });
    const { generation } = store.admission.enable(1);
    expect(() => store.admission.admit(generation, () => {
      store.alert('warn', null, 'inside', 1);
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.listAlerts()).toEqual([]);
    expect(store.admission.read()).toMatchObject({ open: true, generation });
    store.close();
  });
});
