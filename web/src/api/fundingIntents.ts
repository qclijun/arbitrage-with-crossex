import { useQuery } from '@tanstack/react-query';
import type { AcceptBody, receipt } from '../../../src/server/funding/accept';
import type { previewView } from '../../../src/server/funding/previews';
import type { PreviewContent, PreviewRequest } from '../../../src/server/funding/request';
import { fetchJson, postJson } from './client';

export type FundingPreview = Omit<ReturnType<typeof previewView>, 'content'> & { content: PreviewContent };
export type FundingReceipt = ReturnType<typeof receipt> & { duplicate?: boolean };

/** What the user asks to preview (ticket 12's request), exactly as typed. */
export type FundingPreviewRequest = PreviewRequest;
export type FundingAcceptBody = AcceptBody;

export const previewFunding = (req: FundingPreviewRequest) => postJson<FundingPreview>('/funding/preview', req);
export const acceptFunding = (body: FundingAcceptBody) => postJson<FundingReceipt>('/funding/intents', body);

/** Only DONE is final: a HALTED deal still cancels and its fills can still land. */
const FINAL = new Set(['DONE']);

/** The accepted intent's durable receipt, polled until its deal is final. */
export function useFundingReceipt(intentId: string | null) {
  return useQuery({
    queryKey: ['funding', 'intent', intentId],
    queryFn: () => fetchJson<FundingReceipt>(`/funding/intents/${intentId}`),
    enabled: intentId !== null,
    refetchInterval: (query) => (FINAL.has(query.state.data?.deal.mode ?? '') ? false : 2_000),
  });
}
