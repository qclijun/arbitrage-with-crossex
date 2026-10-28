/** Ledger step 3 (ticket 15): the strategy slice ledger, see engine/slices.ts.
 * Quantities are decimal strings; times are local observation times, never
 * venue fill times. */
export const SLICE_SCHEMA = `
CREATE TABLE strategy_slice (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE slice_leg (
  slice_id TEXT NOT NULL REFERENCES strategy_slice(id),
  leg TEXT NOT NULL,
  account TEXT NOT NULL,
  contract TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  unit TEXT NOT NULL,
  qty TEXT NOT NULL,
  PRIMARY KEY (slice_id, leg)
);
CREATE INDEX slice_leg_contract ON slice_leg(account, contract);
CREATE TABLE deal_slice (
  deal_id TEXT PRIMARY KEY REFERENCES pair(id),
  slice_id TEXT NOT NULL REFERENCES strategy_slice(id),
  action TEXT NOT NULL CHECK (action IN ('open', 'add', 'reduce')),
  a_leg TEXT NOT NULL,
  b_leg TEXT
);
CREATE TABLE contract_book (
  account TEXT NOT NULL,
  contract TEXT NOT NULL,
  explained TEXT NOT NULL,
  baseline_at INTEGER NOT NULL,
  flag TEXT,
  PRIMARY KEY (account, contract)
);
CREATE TABLE fill_booking (
  deal_id TEXT NOT NULL REFERENCES pair(id),
  deal_leg TEXT NOT NULL CHECK (deal_leg IN ('A', 'B')),
  booked TEXT NOT NULL,
  PRIMARY KEY (deal_id, deal_leg)
);
CREATE TABLE slice_movement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slice_id TEXT REFERENCES strategy_slice(id),
  leg TEXT,
  account TEXT NOT NULL,
  contract TEXT NOT NULL,
  delta TEXT NOT NULL,
  kind TEXT NOT NULL,
  deal_id TEXT,
  deal_leg TEXT,
  observed_at INTEGER NOT NULL,
  evidence TEXT
);
CREATE INDEX slice_movement_slice ON slice_movement(slice_id, id);
`;
