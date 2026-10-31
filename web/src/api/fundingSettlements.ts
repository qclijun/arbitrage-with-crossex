import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SettlementBoard } from '../../../src/server/funding/settlements';
import { useTabActive } from '../components/TabBar';
import { canFetch } from './queries';
import { fetchJson } from './client';

export type { SettlementBoard, SettlementWindow } from '../../../src/server/funding/settlements';
export interface SettlementParams { venue: string; asset: string; offset: number; }

export function useFundingSettlements(params: SettlementParams) {
  const shown = useTabActive();
  const query = new URLSearchParams({ offset: String(params.offset), limit: '20' });
  if (params.venue) query.set('venue', params.venue);
  if (params.asset) query.set('underlying', params.asset);
  return useQuery({ queryKey: ['funding', 'settlements', params],
    queryFn: () => fetchJson<SettlementBoard>(`/funding/settlements?${query}`),
    enabled: (state) => canFetch(shown, state), refetchInterval: shown ? 60_000 : false, placeholderData: keepPreviousData });
}
