import { useQuery } from '@tanstack/react-query';
import type { AcceptBody, receipt } from '../../../src/server/funding/accept';
import type { LateAcceptance, previewView } from '../../../src/server/funding/previews';
import type { PreviewContent, PreviewRequest } from '../../../src/server/funding/request';
import { ApiError, fetchJson, postJson } from './client';

export type FundingPreview = Omit<ReturnType<typeof previewView>, 'content'> & { content: PreviewContent };
export type FundingReceipt = ReturnType<typeof receipt> & { duplicate?: boolean };

/** What the user asks to preview (ticket 12's request), exactly as typed. */
export type FundingPreviewRequest = PreviewRequest;
export type FundingAcceptBody = AcceptBody;

/** Only DONE is final: a HALTED deal still cancels and its fills can still land. */
export const FINAL_MODES = new Set(['DONE']);

export const previewFunding = (req: FundingPreviewRequest) => postJson<FundingPreview>('/funding/preview', req);

/** An acceptance with no answer by then is given up on and looked up instead (ticket 14). */
export const ACCEPT_TIMEOUT_MS = 15_000;

/** One send of the acceptance; no answer in time is a lost answer, not a refusal. */
export async function acceptFunding(body: FundingAcceptBody, timeoutMs = ACCEPT_TIMEOUT_MS): Promise<FundingReceipt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError({ category: 'network', message: `no answer within ${timeoutMs / 1000} s`, retryable: false })), timeoutMs);
  });
  try {
    return await Promise.race([postJson<FundingReceipt>('/funding/intents', body), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Where a sent intent stands, by its id: only the server's proof makes it `never`. */
export type IntentLookup =
  | { kind: 'accepted'; receipt: FundingReceipt }
  | { kind: 'pending'; until: number | null }
  | { kind: 'never'; reason: Extract<LateAcceptance, { possible: false }>['reason'] };

export async function lookupFundingIntent(body: Pick<FundingAcceptBody, 'intentId' | 'previewId'>): Promise<IntentLookup> {
  try {
    const path = `/funding/intents/${encodeURIComponent(body.intentId)}?previewId=${encodeURIComponent(body.previewId)}`;
    return { kind: 'accepted', receipt: await fetchJson<FundingReceipt>(path) };
  } catch (err) {
    if (!(err instanceof ApiError && err.httpStatus === 404 && err.label === 'intent-unknown')) throw err;
    const late = err.details?.lateAcceptance as LateAcceptance | undefined;
    if (late?.possible === false) return { kind: 'never', reason: late.reason };
    // A bare not-found proves nothing: the request may still be accepted.
    return { kind: 'pending', until: late?.possible ? late.until : null };
  }
}

/** The ledger's accepted intents for one pair, newest first, polled while any deal is unfinished. */
export function useCandidateIntents(candidateId: string) {
  return useQuery({
    queryKey: ['funding', 'intents', 'candidate', candidateId],
    queryFn: () => fetchJson<FundingReceipt[]>(`/funding/intents?candidateId=${encodeURIComponent(candidateId)}`),
    refetchInterval: (query) => (query.state.data?.some((r) => !FINAL_MODES.has(r.deal.mode)) ? 5_000 : false),
  });
}

