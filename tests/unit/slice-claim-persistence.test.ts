import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/engine/db';
import { previewClaim } from '../../src/engine/claim-preview';
import { startLoop } from '../../src/engine/loop';
import { LEDGER_STEPS, prepareLedger } from '../../src/engine/ledger/version';
import type { ClaimEvidence, ClaimInput } from '../../src/engine/claim-types';
import { seedLegacyLedger } from '../helpers/legacy-ledger';
import { LONG_C, SHORT_C } from '../helpers/slice-fixture';
import { FakeVenue } from './engine-sim';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const input: ClaimInput = { kind: 'funding-two-leg', legs: [
  { contract: LONG_C, side: 'long', qty: '0.4' }, { contract: SHORT_C, side: 'short', qty: '0.4' },
], boros: [] };
const ev: ClaimEvidence = { readAt: 100, positions: { [LONG_C]: '1', [SHORT_C]: '-1' },
  contracts: [LONG_C, SHORT_C], openOrders: [], boros: null };

describe('claim migration and restart', () => {
  it('preserves v5 history, fences the old reader and resumes a pending command through the normal loop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-claim-')); dirs.push(dir);
    const file = path.join(dir, 'deals.sqlite');
    seedLegacyLedger(file);
    let db = new DatabaseSync(file);
    prepareLedger(db, { file, now: 10, steps: LEDGER_STEPS.filter((s) => s.to <= 5) });
    const old = ['pair', 'orders', 'alert_log'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    db.close();
    let store = new Store(file, { now: 20 });
    store.claims.preview('one', input, previewClaim(store.slices, input, ev, 100), 100);
    store.claims.confirm('one');
    store.close();
    db = new DatabaseSync(file);
    expect(['pair', 'orders', 'alert_log'].map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(old);
    expect(() => prepareLedger(db, { file, now: 30, steps: LEDGER_STEPS.filter((s) => s.to <= 5) })).toThrow(/newer/);
    db.close();
    store = new Store(file);
    const venue = new FakeVenue();
    const create = vi.spyOn(venue, 'create'); const cancel = vi.spyOn(venue, 'cancel');
    const controller = new AbortController();
    vi.useFakeTimers();
    startLoop({ store, venue, clock: { now: () => 110 }, readClaimEvidence: async () => ev }, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    expect(store.claims.get('one')?.status).toBe('applied');
    expect(store.slices.get('claim:one')?.legs.map((l) => l.qty)).toEqual(['0.4', '0.4']);
    expect(create).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    controller.abort(); vi.clearAllTimers(); store.close();
    store = new Store(file);
    expect(store.claims.get('one')?.status).toBe('applied');
    expect(store.slices.movements('claim:one')).toHaveLength(2);
    store.close();
  });
});
