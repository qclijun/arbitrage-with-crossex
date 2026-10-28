/**
 * A version-0 ledger exactly as every engine release up to 1.7.7 lays it down.
 *
 * `LEGACY_BOOT_SCHEMA` is the verbatim DDL those releases run at boot
 * (`new Store()` → `exec(SCHEMA)`), so executing it against a ledger is what an
 * old program does before its loop or HTTP listener can start. It is a frozen
 * snapshot on purpose: the barrier must stop the text that SHIPPED, not
 * whatever the current source happens to say.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const LEGACY_BOOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS pair (
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
  price_policy TEXT NOT NULL DEFAULT 'touch' CHECK (price_policy IN ('fixed','touch','best')),
  auto_price_policy TEXT NOT NULL DEFAULT 'touch' CHECK (auto_price_policy IN ('touch','best')),
  deadline_at INTEGER,
  maker_not_before INTEGER NOT NULL DEFAULT 0,
  hedge_not_before INTEGER NOT NULL DEFAULT 0,
  poc_rejects INTEGER NOT NULL DEFAULT 0,
  hedge_reject_streak INTEGER NOT NULL DEFAULT 0,
  reprice_count INTEGER NOT NULL DEFAULT 0,
  last_maker_placement_at INTEGER NOT NULL DEFAULT 0,
  post_only_rejects INTEGER NOT NULL DEFAULT 0,
  book_outage_started_at INTEGER NOT NULL DEFAULT 0,
  max_clip TEXT,
  clip_band_bp INTEGER,
  halt_reason TEXT,
  report_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
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
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  pair_id TEXT,
  message TEXT NOT NULL,
  ack INTEGER NOT NULL DEFAULT 0
);
`;

export interface LegacyLedgerOptions {
  /** Mode of the one seeded deal; anything but DONE is still executing. */
  mode?: string;
  /** State of its leg-B order; PENDING/OPEN is a live (possibly unknown) order. */
  bState?: string;
  quarantined?: string | null;
  /** Leave the last writes only in the WAL, as a crash would. */
  leaveWal?: boolean;
}

/** Lay down a version-0 ledger with one deal, two orders, an acked and an
 * unacked alert, a user index and a user trigger, in WAL mode like a real
 * install. `leaveWal` copies the files while the writer is still open, so the
 * seeded rows exist only in the `-wal` file a crash would leave behind. */
export function seedLegacyLedger(file: string, opts: LegacyLedgerOptions = {}): void {
  const source = opts.leaveWal ? `${file}.seed` : file;
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(LEGACY_BOOT_SCHEMA);
    db.prepare(
      `INSERT INTO pair (id, mode, a_contract, a_side, a_lot, a_min_size, a_min_notional, a_tick,
         b_contract, b_side, b_lot, b_min_size, b_min_notional, b_tick,
         target_qty, limit_price, price_policy, deadline_at, report_json, created_at)
       VALUES ('old-deal', ?, 'HYPERLIQUID_FUTURE_ETH_USDC','BUY','0.001','0','0','0.01',
         'OKX_FUTURE_ETH_USDT','SELL','0.001','0','0','0.01',
         '0.152','2500','touch',1770000000000,'{"aFilled":"0.152"}',111)`,
    ).run(opts.mode ?? 'DONE');
    db.prepare(
      `INSERT INTO orders (pair_id, leg, seq, client_id, kind, side, qty, price, tif,
         state, venue_order_id, cum_qty, avg_fill_price, close_reason, created_at, resolved_at)
       VALUES ('old-deal','A',1,'tOldDealA1','maker','BUY','0.152','2500','poc',
         'CLOSED','V-77','0.152','2499.5','filled',112,113)`,
    ).run();
    db.prepare(
      `INSERT INTO orders (pair_id, leg, seq, client_id, kind, side, qty, price, tif,
         state, venue_order_id, cum_qty, avg_fill_price, quarantined_status, created_at)
       VALUES ('old-deal','B',1,'tOldDealB1','taker','SELL','0.152',null,'ioc',
         ?, 'V-78','0.15','2501.25',?,114)`,
    ).run(opts.bState ?? 'CLOSED', opts.quarantined ?? null);
    db.prepare("INSERT INTO alerts (ts, level, pair_id, message, ack) VALUES (115,'warn','old-deal','residual 0.002',1)").run();
    db.prepare("INSERT INTO alerts (ts, level, pair_id, message, ack) VALUES (116,'error',null,'legacy notice',0)").run();
    db.exec('CREATE INDEX pair_created ON pair(created_at)');
    db.exec("CREATE TRIGGER pair_note AFTER UPDATE OF halt_reason ON pair BEGIN SELECT 1; END");
    if (opts.leaveWal) {
      fs.copyFileSync(source, file);
      fs.copyFileSync(`${source}-wal`, `${file}-wal`);
    }
  } finally {
    db.close();
    if (opts.leaveWal) fs.rmSync(source);
  }
}
