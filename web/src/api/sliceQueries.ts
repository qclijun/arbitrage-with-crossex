import { useQuery } from '@tanstack/react-query';
import { useTabActive } from '../components/TabBar';
import type { SlicesResponse } from '../lib/fundingApplicability';
import { fetchJson } from './client';

/** Strategy slices with a fresh reconciliation (ticket 15). Polled faster than
 * the 12 s the Risk page accepts as floating-quantity evidence (ticket 16). */
export function useStrategySlices() {
  const shown = useTabActive();
  return useQuery({ queryKey: ['slices'], structuralSharing: false,
    queryFn: () => fetchJson<SlicesResponse>('/slices'), enabled: shown,
    refetchInterval: shown ? 5_000 : false });
}
