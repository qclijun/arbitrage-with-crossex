/** Current-time ownership commands; no venue orders and no historical rewrite. */
export const CLAIM_SCHEMA = `
CREATE TABLE slice_claim (
  id TEXT PRIMARY KEY,
  content_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preview','pending','applied','rejected')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  applied_at INTEGER,
  reason TEXT
);
`;
