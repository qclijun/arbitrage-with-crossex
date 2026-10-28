/** Ledger step 5 (ticket 12): accepted funding-opportunity intents, see
 * engine/funding-intents.ts. One row per intent id and per preview; the deal
 * and slice it created are named, never inferred. */
export const FUNDING_INTENT_SCHEMA = `
CREATE TABLE funding_intent (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  preview_id TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL,
  deal_id TEXT NOT NULL UNIQUE REFERENCES pair(id),
  slice_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);`;
