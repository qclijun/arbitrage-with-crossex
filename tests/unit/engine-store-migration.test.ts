/**
 * Store migration — proves an EXISTING installation's ledger keeps working.
 *
 * These tests lay down a real SQLite FILE in the pre-change shape (the `pair`
 * CHECK still reads `('fixed','touch')`, and the two new columns are absent),
 * close it, and reopen it through `Store` so `migrate()` actually runs. No
 * in-memory stand-in: the whole point is that a user's on-disk database is the
 * thing being upgraded.
 *
 * `Store` takes `PRAGMA locking_mode = EXCLUSIVE` on file-backed databases and
 * holds it until `close()` (src/engine/db.ts), so every step strictly serializes
 * its Store lifetimes — a second `new Store(path)` while one is open throws
 * `database is locked`. Each test gets its own temp dir.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { fx } from '../../src/engine/fx';

const dirs: string[] = [];

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-store-migration-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * The `pair` table EXACTLY as it shipped before this change: the price_policy
 * CHECK is the old two-value one and neither new column exists. `orders` is the
 * current shape (it is what migrate() already probes) so the foreign key to
 * `pair` is real and the rebuild actually has to cope with it.
 */
const OLD_SCHEMA = `
CREATE TABLE pair (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('OPENING','CONVERTING','STOPPING','HALTED','DONE')),
  a_contract TEXT NOT NULL, a_side TEXT NOT NULL, a_lot TEXT NOT NULL,
  a_min_size TEXT NOT NULL, a_min_notional TEXT NOT NULL,
  a_tick TEXT NOT NULL DEFAULT '0.0001', a_reduce_only INTEGER NOT NULL DEFAULT 0,
  b_contract TEXT, b_side TEXT, b_lot TEXT,
  b_min_size TEXT, b_min_notional TEXT,
  b_tick TEXT, b_reduce_only INTEGER NOT NULL DEFAULT 0,
  target_qty TEXT NOT NULL,
  limit_price TEXT,
  price_policy TEXT NOT NULL DEFAULT 'touch' CHECK (price_policy IN ('fixed','touch')),
  deadline_at INTEGER,
  maker_not_before INTEGER NOT NULL DEFAULT 0,
  hedge_not_before INTEGER NOT NULL DEFAULT 0,
  poc_rejects INTEGER NOT NULL DEFAULT 0,
  hedge_reject_streak INTEGER NOT NULL DEFAULT 0,
  max_clip TEXT,
  clip_band_bp INTEGER,
  halt_reason TEXT,
  report_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE orders (
  pair_id TEXT NOT NULL REFERENCES pair(id),
  leg TEXT NOT NULL CHECK (leg IN ('A','B')),
  seq INTEGER NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('maker','taker')),
  side TEXT NOT NULL,
  qty TEXT NOT NULL,
  price TEXT,
  tif TEXT NOT NULL CHECK (tif IN ('poc','ioc')),
  state TEXT NOT NULL CHECK (state IN ('PENDING','OPEN','CLOSED','DEAD')),
  venue_order_id TEXT,
  cum_qty TEXT NOT NULL DEFAULT '0',
  avg_fill_price TEXT NOT NULL DEFAULT '0',
  close_reason TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  quarantined_status TEXT,
  venue_reason TEXT,
  read_fail_streak INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (pair_id, leg, seq)
);
`;

/** Write a pre-change database file and close it. */
function seedOldDb(file: string, opts?: { extraOrder?: boolean }): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(OLD_SCHEMA);
    db.exec(`PRAGMA foreign_keys = ON`);
    db.prepare(
      `INSERT INTO pair (id, mode,
         a_contract, a_side, a_lot, a_min_size, a_min_notional, a_tick, a_reduce_only,
         b_contract, b_side, b_lot, b_min_size, b_min_notional, b_tick, b_reduce_only,
         target_qty, limit_price, price_policy, deadline_at,
         maker_not_before, hedge_not_before, poc_rejects, hedge_reject_streak,
         max_clip, clip_band_bp, halt_reason, report_json, created_at)
       VALUES ('old-deal','CONVERTING',
         'HYPERLIQUID_FUTURE_ETH_USDC','BUY','0.001','0','0','0.01',0,
         'OKX_FUTURE_ETH_USDT','SELL','0.001','0','0','0.01',0,
         '0.152','2500','touch',1770000000000,
         40,50,2,1,
         null,null,null,null,111)`,
    ).run();
    db.prepare(
      `INSERT INTO orders (pair_id, leg, seq, client_id, kind, side, qty, price, tif,
         state, venue_order_id, cum_qty, avg_fill_price, close_reason, created_at, resolved_at)
       VALUES ('old-deal','A',1,'tOldDealA1','maker','BUY','0.152','2500','poc',
         'CLOSED','V-77','0.152','2499.5','filled',112,113)`,
    ).run();
    if (opts?.extraOrder) {
      db.prepare(
        `INSERT INTO orders (pair_id, leg, seq, client_id, kind, side, qty, price, tif,
           state, cum_qty, created_at)
         VALUES ('old-deal','B',1,'tOldDealB1','taker','SELL','0.152',null,'ioc',
           'OPEN','0',114)`,
      ).run();
    }
  } finally {
    db.close();
  }
}

describe('Store migration of a pre-existing file', () => {
  it("adds the pair columns with defaults and widens the CHECK so a legacy deal can take 'best'", () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    seedOldDb(file);

    // Reopen through Store — this is the upgrade a user gets on the next boot.
    const store = new Store(file);
    try {
      // The pre-existing row came back with every value intact and reinterpreted
      // as nothing.
      const old = store.getPair('old-deal')!;
      expect(old.mode).toBe('CONVERTING');
      expect(old.pricePolicy).toBe('touch'); // still the ORIGINAL value
      expect(old.targetQty).toBe('0.152');
      expect(old.limitPrice).toBe('2500');
      expect(old.deadlineAt).toBe(1770000000000);
      expect(old.makerNotBefore).toBe(40);
      expect(old.hedgeNotBefore).toBe(50);
      expect(old.pocRejects).toBe(2);
      expect(old.hedgeRejectStreak).toBe(1);

      // A column the old row never had reads back as its documented default —
      // NOT `undefined`. `undefined >= 20` is false, so an unbounded counter is
      // exactly the silent "unlimited reprice" the spec forbids.
      expect(old.repriceCount).toBe(0);
      expect(old.lastMakerPlacementAt).toBe(0);

      // The historical order is byte-for-byte what was written.
      const orders = store.listOrders('old-deal');
      expect(orders).toHaveLength(1);
      expect(orders[0].clientId).toBe('tOldDealA1');
      expect(orders[0].state).toBe('CLOSED');
      expect(orders[0].cumQty).toBe('0.152');
      expect(orders[0].avgFillPrice).toBe('2499.5');
      expect(orders[0].venueOrderId).toBe('V-77');

      // The widened CHECK accepts the new value on the legacy database.
      store.updatePair('old-deal', { pricePolicy: 'best' });
      expect(store.getPair('old-deal')!.pricePolicy).toBe('best');

      // ...and the new columns are writable and read back.
      store.updatePair('old-deal', { repriceCount: 3, lastMakerPlacementAt: 999 });
      const after = store.getPair('old-deal')!;
      expect(after.repriceCount).toBe(3);
      expect(after.lastMakerPlacementAt).toBe(999);
    } finally {
      store.close();
    }
  });

  it('preserves every orders row (and its foreign key) across the table rebuild', () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    seedOldDb(file, { extraOrder: true });

    const store = new Store(file);
    try {
      // The rebuild DROPs and recreates `pair`; a naive drop with foreign_keys
      // ON either fails or cascades. Both orders must still be here.
      const orders = store.listOrders('old-deal');
      expect(orders.map((o) => o.clientId).sort()).toEqual(['tOldDealA1', 'tOldDealB1']);
      expect(orders.find((o) => o.leg === 'B')!.state).toBe('OPEN');
      expect(store.getPair('old-deal')!.targetQty).toBe('0.152');
    } finally {
      store.close();
    }

    // ...and they survive a second reopen (post-migration steady state).
    const again = new Store(file);
    try {
      expect(again.listOrders('old-deal')).toHaveLength(2);
    } finally {
      again.close();
    }
  });

  it('keeps the widened CHECK and new columns working across a reopen (idempotent rebuild)', () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    seedOldDb(file);

    const s1 = new Store(file);
    s1.updatePair('old-deal', { pricePolicy: 'best', repriceCount: 20 });
    s1.close();

    // Second boot must not rebuild again — the CHECK already admits 'best', so
    // re-running the rebuild would be wasted work and a needless risk.
    const s2 = new Store(file);
    try {
      const pair = s2.getPair('old-deal')!;
      expect(pair.pricePolicy).toBe('best');
      expect(pair.repriceCount).toBe(20);
      s2.updatePair('old-deal', { repriceCount: 21 });
      expect(s2.getPair('old-deal')!.repriceCount).toBe(21);
    } finally {
      s2.close();
    }
  });

  it('lets a freshly-created deal carry the new fields end to end', () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    const store = new Store(file); // fresh install: SCHEMA already has 'best'
    try {
      store.createPair({
        id: 'new-deal',
        mode: 'OPENING',
        a: { contract: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
        b: { contract: 'OKX_FUTURE_ETH_USDT', side: 'SELL', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
        targetQty: '0.152',
        limitPrice: null,
        pricePolicy: 'best',
        deadlineAt: 123,
        makerNotBefore: 0,
        hedgeNotBefore: 0,
        pocRejects: 0,
        hedgeRejectStreak: 0,
        repriceCount: 7,
        lastMakerPlacementAt: 555,
        maxClip: null,
        clipBandBp: null,
        haltReason: null,
        reportJson: null,
        createdAt: 1,
      });
      const got = store.getPair('new-deal')!;
      expect(got.pricePolicy).toBe('best');
      expect(got.repriceCount).toBe(7);
      expect(got.lastMakerPlacementAt).toBe(555);
    } finally {
      store.close();
    }
  });
});

describe('Store migration does not disturb the orders-table probe', () => {
  it('still adds the orders columns an even older ledger is missing', () => {
    const file = path.join(tempDir(), 'deals.sqlite');
    // An orders table WITHOUT avg_fill_price / venue_reason / read_fail_streak —
    // the shape migrate() was originally written for.
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE pair (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('OPENING','CONVERTING','STOPPING','HALTED','DONE')),
        a_contract TEXT NOT NULL, a_side TEXT NOT NULL, a_lot TEXT NOT NULL,
        a_min_size TEXT NOT NULL, a_min_notional TEXT NOT NULL,
        a_tick TEXT NOT NULL DEFAULT '0.0001', a_reduce_only INTEGER NOT NULL DEFAULT 0,
        b_contract TEXT, b_side TEXT, b_lot TEXT, b_min_size TEXT, b_min_notional TEXT,
        b_tick TEXT, b_reduce_only INTEGER NOT NULL DEFAULT 0,
        target_qty TEXT NOT NULL, limit_price TEXT,
        price_policy TEXT NOT NULL DEFAULT 'touch' CHECK (price_policy IN ('fixed','touch')),
        deadline_at INTEGER, maker_not_before INTEGER NOT NULL DEFAULT 0,
        hedge_not_before INTEGER NOT NULL DEFAULT 0, poc_rejects INTEGER NOT NULL DEFAULT 0,
        hedge_reject_streak INTEGER NOT NULL DEFAULT 0, max_clip TEXT, clip_band_bp INTEGER,
        halt_reason TEXT, report_json TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE orders (
        pair_id TEXT NOT NULL REFERENCES pair(id),
        leg TEXT NOT NULL, seq INTEGER NOT NULL, client_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, side TEXT NOT NULL, qty TEXT NOT NULL, price TEXT,
        tif TEXT NOT NULL, state TEXT NOT NULL, venue_order_id TEXT,
        cum_qty TEXT NOT NULL DEFAULT '0', close_reason TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0, quarantined_status TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER,
        PRIMARY KEY (pair_id, leg, seq));`);
    db.prepare(`INSERT INTO pair (id, mode, a_contract, a_side, a_lot, a_min_size, a_min_notional, target_qty, price_policy, created_at) VALUES ('o2','OPENING','C','BUY','0.001','0','0','0.152','touch',1)`).run();
    db.prepare(`INSERT INTO orders (pair_id, leg, seq, client_id, kind, side, qty, tif, state, cum_qty, created_at) VALUES ('o2','A',1,'tO2A1','maker','BUY','0.152','poc','CLOSED','0.152',1)`).run();
    db.close();

    const store = new Store(file);
    try {
      const row = store.listOrders('o2')[0];
      // avg_fill_price backfilled to '0' by the orders branch — not undefined.
      expect(row.avgFillPrice).toBe('0');
      expect(row.venueReason).toBeNull();
      expect(row.readFailStreak).toBe(0);
      // and the pair row still read fine
      expect(fx(store.getPair('o2')!.targetQty)).toBe(fx('0.152'));
    } finally {
      store.close();
    }
  });
});
