import { useRef } from 'react';
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
  /** The selected pair, returned as `selected` whenever it is off the page. */
  selected?: string;
}

export function boardPath(p: BoardParams): string {
  const q = new URLSearchParams({ days: String(p.days), offset: String(p.offset) });
  if (p.underlying) q.set('underlying', p.underlying);
  if (p.venue) q.set('venue', p.venue);
  if (p.positive) q.set('positive', '1');
  if (p.rankingId) q.set('rankingId', p.rankingId);
  if (p.selected) q.set('selected', p.selected);
  return `/funding/opportunities?${q}`;
}

/**
 * The read-only ranking (ticket 18). The server reads memory only, so polling never reaches a venue.
 * Each read also asks for the `selected` pair, but selecting is no reason to read again: a pair is
 * picked from the page it is on, and only a later read can move it off.
 */
export function useFundingOpportunities(params: BoardParams, selected: string | null = null) {
  const shown = useTabActive();
  const pick = useRef(selected);
  pick.current = selected;
  return useQuery({
    queryKey: ['funding', 'opportunities', params],
    queryFn: () => fetchJson<FundingBoard>(boardPath({ ...params, ...(pick.current ? { selected: pick.current } : {}) })),
    enabled: (query) => canFetch(shown, query),
    refetchInterval: shown ? 60_000 : false,
    placeholderData: keepPreviousData,
  });
}
