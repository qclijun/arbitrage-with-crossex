/**
 * Accepted funding-opportunity intents (ticket 12): the durable link from the
 * user's intent id to what they confirmed — its business fingerprint, the
 * preview it consumed, the candidate — and to the deal and slice it created.
 * Written only inside the acceptance transaction (server/funding/accept.ts);
 * the table is created by ledger step 5.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface FundingIntentRow {
  id: string;
  /** Hash of the business content the user confirmed; a retry must match it. */
  fingerprint: string;
  previewId: string;
  candidateId: string;
  dealId: string;
  sliceId: string;
  /** The confirmed preview content, verbatim. */
  content: unknown;
  acceptedAt: number;
}

interface DbRow {
  id: string; fingerprint: string; preview_id: string; candidate_id: string;
  deal_id: string; slice_id: string; content_json: string; accepted_at: number;
}

const toRow = (r: DbRow | undefined): FundingIntentRow | null => r ? {
  id: r.id, fingerprint: r.fingerprint, previewId: r.preview_id, candidateId: r.candidate_id,
  dealId: r.deal_id, sliceId: r.slice_id, content: JSON.parse(r.content_json), acceptedAt: r.accepted_at,
} : null;

export class FundingIntents {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): FundingIntentRow | null {
    return toRow(this.db.prepare('SELECT * FROM funding_intent WHERE id = ?').get(id) as unknown as DbRow | undefined);
  }

  byPreview(previewId: string): FundingIntentRow | null {
    return toRow(this.db.prepare('SELECT * FROM funding_intent WHERE preview_id = ?').get(previewId) as unknown as DbRow | undefined);
  }

  /** Every intent accepted for this candidate, newest first. */
  byCandidate(candidateId: string): FundingIntentRow[] {
    const rows = this.db.prepare('SELECT * FROM funding_intent WHERE candidate_id = ? ORDER BY accepted_at DESC, id DESC')
      .all(candidateId) as unknown as DbRow[];
    return rows.map((r) => toRow(r)!);
  }

  /** Throws on a second row for the same intent id, preview or deal. */
  insert(row: FundingIntentRow): void {
    this.db.prepare(
      `INSERT INTO funding_intent (id, fingerprint, preview_id, candidate_id, deal_id, slice_id, content_json, accepted_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(row.id, row.fingerprint, row.previewId, row.candidateId, row.dealId, row.sliceId, JSON.stringify(row.content), row.acceptedAt);
  }
}
