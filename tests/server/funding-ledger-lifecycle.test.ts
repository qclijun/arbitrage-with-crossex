/** Synthetic v0 ledger → closed admission → new intent → safe rollback refusal. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { tickPair } from '../../src/engine/loop';
import { restoreLedgerBackup } from '../../src/engine/ledger/restore';
import { LEDGER_VERSION } from '../../src/engine/ledger/version';
import { LEGACY_BOOT_SCHEMA, seedLegacyLedger } from '../helpers/legacy-ledger';
import { integratedFundingWorld } from '../helpers/funding-integrated-fixture';
import { confirm, LONG_SYMBOL, request } from '../helpers/funding-intent-fixture';
import { NOW } from '../helpers/funding-ranking-fixture';

const dirs: string[] = [];
let app: FastifyInstance | undefined;
let held: Store | undefined;
afterEach(async () => {
  await app?.close(); app = undefined;
  held?.close(); held = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = () => {
  const dir = mkdtempSync(join(tmpdir(), 'funding-ledger-lifecycle-')); dirs.push(dir);
  return { dir, file: join(dir, 'deals.sqlite') };
};
const backup = (dir: string) => join(dir, 'ledger-backups', readdirSync(join(dir, 'ledger-backups')).find((f) => f.endsWith('.sqlite'))!);
const failure = (run: () => unknown) => {
  try { run(); } catch (error) { return error; }
  throw new Error('expected ledger refusal');
};

it('preserves old facts, refuses an active upgrade and old-program boot, and never restores over a new accepted trade', async () => {
  const { dir, file } = files();
  seedLegacyLedger(file, { mode: 'OPENING', bState: 'PENDING' });
  const original = sha(file);
  expect(failure(() => new Store(file, { now: NOW }))).toMatchObject({ code: 'not-quiescent' });
  expect(sha(file)).toBe(original);
  // These are fixture arrangements representing the OLD loop's confirmed drain,
  // not supported SQL instructions for a real account or live migration.
  const legacy = new DatabaseSync(file);
  legacy.exec("UPDATE pair SET mode='DONE'; UPDATE orders SET state='CLOSED'"); legacy.close();
  const store = new Store(file, { now: NOW, programVersion: '9.9.9' });
  held = store;
  const saved = backup(dir);
  const savedHash = sha(saved);
  const b = new DatabaseSync(saved, { readOnly: true });
  expect(b.prepare('SELECT client_id,cum_qty FROM orders ORDER BY leg').all()).toEqual([
    { client_id: 'tOldDealA1', cum_qty: '0.152' }, { client_id: 'tOldDealB1', cum_qty: '0.15' },
  ]);
  b.close();
  const w = await integratedFundingWorld({ store }); app = w.app;
  const board = (await w.get()).body.data;
  expect(board.admission.open).toBe(false);
  expect(store.getPair('old-deal')).toMatchObject({ mode: 'DONE', targetQty: '0.152' });
  const row = board.rows[0];
  await w.post('/api/admission', { open: true });
  const preview = await w.post('/api/funding/preview', request({ quantity: '0.15', snapshotId: board.snapshotId, short: row.short, long: row.long }));
  const accepted = await w.post('/api/funding/intents', confirm(preview, 'after-upgrade'));
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  const id = accepted.body.data.dealId;
  await w.post('/api/admission', { open: false });
  for (let i = 0; i < 3; i++) { await tickPair(w, id); w.clock.advance(1000); }
  w.venue.fill(w.venue.liveOrder(LONG_SYMBOL)!.clientText, '0.15');
  for (let i = 0; i < 5; i++) { await tickPair(w, id); w.clock.advance(1000); }
  expect(store.getPair(id)).toMatchObject({ mode: 'DONE', targetQty: '0.15' });
  await app.close(); app = undefined;
  store.close(); held = undefined;
  expect(failure(() => restoreLedgerBackup({ backupFile: saved, now: NOW + 10_000 }))).toMatchObject({ code: 'ledger-has-new-writes' });
  expect(sha(saved)).toBe(savedHash);
  const oldProgram = new DatabaseSync(file);
  expect(() => oldProgram.exec(LEGACY_BOOT_SCHEMA)).toThrow(/already an index named alerts/);
  expect(oldProgram.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: LEDGER_VERSION });
  oldProgram.close();
  const reopened = new Store(file, { programVersion: '9.9.9' });
  try {
    expect(reopened.getPair('old-deal')).toMatchObject({ mode: 'DONE', targetQty: '0.152' });
    expect(reopened.getPair(id)).toMatchObject({ mode: 'DONE', targetQty: '0.15' });
    expect(reopened.slices.get(accepted.body.data.sliceId)).not.toBeNull();
    expect(reopened.admission.read().open).toBe(false);
  } finally { reopened.close(); }
});

it('restores an untouched upgrade only after its closed observation server releases the ledger, preserving the replaced file', async () => {
  const { dir, file } = files();
  seedLegacyLedger(file);
  const store = new Store(file, { now: NOW, programVersion: '9.9.9' });
  held = store;
  const saved = backup(dir);
  const w = await integratedFundingWorld({ store }); app = w.app;
  expect((await w.get()).body.data.admission.open).toBe(false);
  expect(failure(() => restoreLedgerBackup({ backupFile: saved, now: NOW + 1 }))).toMatchObject({ code: 'ledger-in-use' });
  await app.close(); app = undefined;
  store.close(); held = undefined;
  const restored = restoreLedgerBackup({ backupFile: saved, now: NOW + 5_000 });
  expect(restored.version).toBe(0);
  expect(existsSync(restored.replacedFile)).toBe(true);
  const oldProgram = new DatabaseSync(file);
  try {
    expect(() => oldProgram.exec(LEGACY_BOOT_SCHEMA)).not.toThrow();
    expect(oldProgram.prepare('SELECT client_id FROM orders ORDER BY leg').all()).toEqual([
      { client_id: 'tOldDealA1' }, { client_id: 'tOldDealB1' },
    ]);
  } finally { oldProgram.close(); }
});
