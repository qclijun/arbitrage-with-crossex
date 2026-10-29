import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTabActive } from '../components/TabBar';
import type { FundingBoard } from '../../../src/server/funding/board';
import { fetchJson } from './client';
import { canFetch } from './queries';

export type { BoardLeg, BoardLegHistory, BoardRow, BoardWindow, FundingBoard } from '../../../src/server/funding/board';

export interface BoardParams {
  days: number;
  underlying: string | null;
  venue: string | null;
  positive: boolean;
  offset: number;
  /** The ranking being paged through; absent on page one of a fresh browse. */
  rankingId?: string;
}

export function boardPath(p: BoardParams): string {
  const q = new URLSearchParams({ days: String(p.days), offset: String(p.offset) });
  if (p.underlying) q.set('underlying', p.underlying);
  if (p.venue) q.set('venue', p.venue);
  if (p.positive) q.set('positive', '1');
  if (p.rankingId) q.set('rankingId', p.rankingId);
  return `/funding/opportunities?${q}`;
}

/** The read-only ranking (ticket 18). The server reads memory only, so polling never reaches a venue. */
export function useFundingOpportunities(params: BoardParams) {
  const shown = useTabActive();
  return useQuery({
    queryKey: ['funding', 'opportunities', params],
    queryFn: () => fetchJson<FundingBoard>(boardPath(params)),
    enabled: (query) => canFetch(shown, query),
    refetchInterval: shown ? 60_000 : false,
    placeholderData: keepPreviousData,
  });
}
