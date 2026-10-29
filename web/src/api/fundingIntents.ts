import { useQuery } from '@tanstack/react-query';
import type { receipt } from '../../../src/server/funding/accept';
import type { previewView } from '../../../src/server/funding/previews';
import type { PreviewContent } from '../../../src/server/funding/request';
import { fetchJson, postJson } from './client';

export type FundingPreview = Omit<ReturnType<typeof previewView>, 'content'> & { content: PreviewContent };
export type FundingReceipt = ReturnType<typeof receipt> & { duplicate?: boolean };

/** What the user asks to preview (ticket 12's request), exactly as typed. */
export interface FundingPreviewRequest {
  underlying: string;
  short: { venue: string; contractId: string; symbol: string };
  long: { venue: string; contractId: string; symbol: string };
  snapshotId: string;
  windowDays: number;
  quantity: string;
  makerLeg: 'short' | 'long';
  leverage: { short: string; long: string };
  makerPrice: string | null;
  timeoutSec: number;
  holdDays: string;
}

export interface FundingAcceptBody {
  intentId: string;
  previewId: string;
  contentHash: string;
  authorizeConversion: boolean;
  acknowledgeRisks: boolean;
}

export const previewFunding = (req: FundingPreviewRequest) => postJson<FundingPreview>('/funding/preview', req);
export const acceptFunding = (body: FundingAcceptBody) => postJson<FundingReceipt>('/funding/intents', body);

/** Modes after which a deal no longer changes. */
const FINAL = new Set(['DONE', 'HALTED']);

/** The accepted intent's durable receipt, polled until its deal is final. */
export function useFundingReceipt(intentId: string | null) {
  return useQuery({
    queryKey: ['funding', 'intent', intentId],
    queryFn: () => fetchJson<FundingReceipt>(`/funding/intents/${intentId}`),
    enabled: intentId !== null,
    refetchInterval: (query) => (FINAL.has(query.state.data?.deal.mode ?? '') ? false : 2_000),
  });
}
