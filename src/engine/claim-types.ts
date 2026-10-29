import type { SliceKind, SliceSide } from './slices';

export interface ClaimInput {
  kind: SliceKind;
  legs: Array<{ contract: string; side: SliceSide; qty: string }>;
  root?: string;
  boros: Array<{ key: string; qty: string }>;
}

/** One physical Boros holding, expanded to its funding sources without
 * duplicating its quantity. Spread sources share this single key. */
export interface ClaimBoros {
  key: string; root: string; accountId: number; marketAcc: string; marketId: number;
  base: string; qty: string; unit: string; maturity: number;
  sources: Array<{ venue: string; side: SliceSide }>;
}

export interface ClaimEvidence {
  readAt: number;
  positions: Record<string, string>;
  /** Exact live FUTURE symbols whose quantity is in underlying base units. */
  contracts: string[];
  openOrders: string[];
  boros: ClaimBoros[] | null;
}

export interface ClaimPreview {
  fingerprint: string;
  readAt: number;
  legs: Array<{ contract: string; side: SliceSide; qty: string; actual: string; available: string; remaining: string }>;
  boros: Array<ClaimBoros & { claimed: string; remaining: string }>;
  attribution: { funding: null; fees: null; pnl: null; equityReturn: null; reason: string };
}

export const UNKNOWN_ATTRIBUTION: ClaimPreview['attribution'] = {
  funding: null, fees: null, pnl: null, equityReturn: null,
  reason: 'UNKNOWN: per-slice cash flows, fill times, fees and capital are not proven. Account/contract totals remain separate; no historical allocation.',
};

export interface ClaimRow {
  id: string; input: ClaimInput; preview: ClaimPreview;
  status: 'preview' | 'pending' | 'applied' | 'rejected';
  createdAt: number; expiresAt: number; appliedAt: number | null; reason: string | null;
  /** GET-only server-clock proof for an unaccepted confirmation. */
  confirmationPossible?: boolean;
}
