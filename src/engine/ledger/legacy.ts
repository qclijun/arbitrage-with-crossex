/**
 * The version-0 ledger: the schema every release before the version protocol
 * created, and the in-place column/CHECK upgrades those releases applied at
 * boot. Version 0 is not one shape but this family; the version-1 step folds
 * all of it into a single transaction.
 */
import type { DatabaseSync } from 'node:sqlite';

export const LEGACY_SCHEMA = `
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

const PRICE_POLICY_CHECK = /(CHECK\s*\(\s*(?:price_policy|"price_policy"|`price_policy`|\[price_policy\])\s+IN\s*\()([^)]*)(\)\s*\))/i;

/** Columns added after the table first shipped. SQLite has no "ADD COLUMN IF
 * NOT EXISTS", so probe table_info and add when missing; existing rows keep
 * their data and read the documented default. */
const ADDED_COLUMNS: Record<'orders' | 'pair', Array<[string, string]>> = {
  orders: [
    ['avg_fill_price', `TEXT NOT NULL DEFAULT '0'`],
    ['venue_reason', 'TEXT'],
    ['read_fail_streak', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  pair: [
    ['reprice_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_maker_placement_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['post_only_rejects', 'INTEGER NOT NULL DEFAULT 0'],
    // A pre-'best' database has no family policy. 'touch' is the historical
    // default and is correct for every such row (no old deal was 'best').
    ['auto_price_policy', `TEXT NOT NULL DEFAULT 'touch'`],
    ['book_outage_started_at', 'INTEGER NOT NULL DEFAULT 0'],
  ],
};

/** Bring any version-0 shape to the latest version-0 shape. The caller holds
 * the transaction with foreign-key enforcement OFF and checks foreign keys
 * before committing — `pair` may be rebuilt, and `orders` references it. */
export function normalizeLegacyTables(db: DatabaseSync): void {
  for (const table of ['orders', 'pair'] as const) {
    const cols = columns(db, table);
    for (const [name, decl] of ADDED_COLUMNS[table]) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    }
  }
  // `ALTER TABLE ADD COLUMN` can never widen an existing CHECK, so a ledger
  // built before 'best' would throw the first time a deal stored it.
  if (!pairCheckAdmits(db, 'best')) rebuildPairWithWidenedCheck(db);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
}

/** The stored DDL in sqlite_master is the only place a CHECK is observable —
 * PRAGMA table_info does not report them. */
function pairCheckAdmits(db: DatabaseSync, value: string): boolean {
  const values = pairSchema(db).match(PRICE_POLICY_CHECK)?.[2];
  return values?.split(',').some((entry) => entry.trim() === `'${value}'`) ?? false;
}

function pairSchema(db: DatabaseSync): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pair'`)
    .get() as unknown as { sql: string } | undefined;
  if (!row) throw new Error('pair schema is missing');
  return row.sql;
}

/**
 * Rebuild `pair` with 'best' added to its price_policy CHECK (create → copy →
 * drop → rename), preserving the actual installed schema — every column,
 * including ones other versions introduced, every row, index and trigger. A
 * canonical field list cannot safely recreate an installation that also
 * carries e.g. account_scope.
 */
function rebuildPairWithWidenedCheck(db: DatabaseSync): void {
  const schema = pairSchema(db);
  if (!PRICE_POLICY_CHECK.test(schema)) throw new Error('cannot recognize pair price_policy CHECK; ledger left intact');
  const widened = schema.replace(PRICE_POLICY_CHECK, (_match, prefix: string, values: string, suffix: string) =>
    `${prefix}${values},'best'${suffix}`,
  );
  const target = widened.replace(
    /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:pair|"pair"|'pair'|`pair`|\[pair\])(?=\s*\()/i,
    'CREATE TABLE pair_rebuild',
  );
  if (target === widened) throw new Error('cannot recognize pair table declaration; ledger left intact');
  const objects = db.prepare(
    "SELECT sql FROM sqlite_master WHERE tbl_name = 'pair' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name",
  ).all() as unknown as { sql: string }[];
  // table_info excludes generated columns, which are recomputed by SQLite.
  const cols = columns(db, 'pair').map((name) => `"${name.replaceAll('"', '""')}"`).join(', ');
  db.exec('DROP TABLE IF EXISTS pair_rebuild');
  db.exec(target);
  db.exec(`INSERT INTO pair_rebuild (${cols}) SELECT ${cols} FROM pair`);
  db.exec('DROP TABLE pair');
  db.exec('ALTER TABLE pair_rebuild RENAME TO pair');
  for (const object of objects) db.exec(object.sql);
}
