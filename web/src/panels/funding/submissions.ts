/**
 * This browser's durable record of funding acceptances it sent (ticket 14).
 * An intent is written here, and read back, before it is sent; it stays until
 * the server shows it was refused or can never be accepted, or the user
 * dismisses its finished receipt. There is no expiry: a lost answer is looked
 * up by this exact id however late. Each intent has its own key, so tabs that
 * write at once never overwrite each other's records. Unlike lib/storage
 * nothing is best-effort: a record that cannot be written means the intent is
 * not sent, and a record that cannot be read is reported, never replaced.
 */
import type { FundingAcceptBody } from '../../api/fundingIntents';

export const SUBMISSION_KEY_PREFIX = 'crossex.fundingSubmission.v1.';
const keyOf = (intentId: string) => `${SUBMISSION_KEY_PREFIX}${intentId}`;

export interface SubmissionRecord {
  /** The board candidate (exact pair) the intent opens. */
  candidateId: string;
  /** The acceptance exactly as sent; its intentId is the identity. */
  body: FundingAcceptBody;
  savedAt: number;
}

export type Loaded = { ok: true; records: Record<string, SubmissionRecord> } | { ok: false; error: string };

const isRecord = (v: unknown): v is SubmissionRecord => {
  const r = v as Partial<SubmissionRecord> | null;
  const b = r?.body as Partial<FundingAcceptBody> | undefined;
  return !!r && typeof r.candidateId === 'string' && typeof r.savedAt === 'number' && !!b && typeof b.intentId === 'string'
    && typeof b.previewId === 'string' && typeof b.contentHash === 'string';
};

export function loadSubmissions(): Loaded {
  const records: Record<string, SubmissionRecord> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(SUBMISSION_KEY_PREFIX)) continue;
      const id = key.slice(SUBMISSION_KEY_PREFIX.length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
      } catch {
        parsed = null;
      }
      if (!isRecord(parsed) || parsed.body.intentId !== id) {
        return { ok: false, error: `the stored record of a sent intent is unreadable (${key})` };
      }
      records[id] = parsed;
    }
  } catch (err) {
    return { ok: false, error: `this browser's storage cannot be read (${(err as Error).message})` };
  }
  return { ok: true, records };
}

/** True only once the record is stored and reads back exactly. */
export function saveSubmission(record: SubmissionRecord): boolean {
  const key = keyOf(record.body.intentId);
  const text = JSON.stringify(record);
  try {
    localStorage.setItem(key, text);
    return localStorage.getItem(key) === text;
  } catch {
    return false;
  }
}

/** True once no record of the intent remains. */
export function forgetSubmission(intentId: string): boolean {
  const key = keyOf(intentId);
  try {
    localStorage.removeItem(key);
    return localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}
