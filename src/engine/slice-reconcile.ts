/**
 * Per-contract reconciliation of the strategy slice ledger (ticket 15). Pure:
 * the ledger's view of one contract plus one fresh signed position reading.
 *
 *   actual = attributed (Σ slice legs, signed) + unattributed
 *
 * holds by construction, so it proves nothing on its own. A contract is
 * reconciled only when the position is exactly what the ledger explains —
 * its baseline plus every engine fill since — no execution on it is in
 * flight, nothing is flagged, and the attribution fits inside the position on
 * the same side. Anything else is a named non-reconciled status, which blocks
 * new risk on that contract and nothing else. Equal readings at two moments
 * cannot prove nothing happened in between; that stays a known limit.
 */
import { fx, fxStr } from './fx';

export interface ContractState {
  contract: string;
  /** Signed net the ledger can explain; null = no slice ever tracked it. */
  explained: string | null;
  /** Set when booking hit something only the user can resolve. */
  flag: string | null;
  inFlight: boolean;
  legs: Array<{ sliceId: string; leg: string; side: 'long' | 'short'; qty: string }>;
}

export type ReconcileStatus =
  | 'reconciled'
  | 'untracked'
  | 'unknown'
  | 'in-flight'
  | 'needs-recovery'
  | 'external-change'
  | 'over-attributed';

export interface Reconciliation {
  status: ReconcileStatus;
  /** Signed actual net position, as read; null when unread. */
  actual: string | null;
  explained: string | null;
  /** Signed sum of slice legs on this contract. */
  attributed: string;
  /** actual − attributed; null when the actual is unknown. */
  unattributed: string | null;
  /** UNKNOWN: a tracked contract that is not reconciled. New risk on it is
   * refused until it is; hedges and reductions continue. */
  unknown: boolean;
}

export function signedAttribution(legs: ContractState['legs']): bigint {
  return legs.reduce((sum, l) => sum + (l.side === 'long' ? fx(l.qty) : -fx(l.qty)), 0n);
}

/** True when the slices are a same-side part of `actual`. Slices holding one
 * net position both ways never fit: their netted sum would hide two
 * fictitious inner positions. */
export function fitsInside(legs: ContractState['legs'], actual: bigint): boolean {
  const held = legs.filter((l) => fx(l.qty) !== 0n);
  if (held.some((l) => l.side === 'long') && held.some((l) => l.side === 'short')) return false;
  const attributed = signedAttribution(held);
  if (attributed === 0n) return true;
  return attributed > 0n ? actual >= attributed : actual <= attributed;
}

export function reconcileContract(state: ContractState, actual: string | null): Reconciliation {
  const r = judge(state, actual);
  return { ...r, unknown: r.status !== 'reconciled' && r.status !== 'untracked' };
}

function judge(state: ContractState, actual: string | null): Omit<Reconciliation, 'unknown'> {
  const attributed = signedAttribution(state.legs);
  const base = {
    actual,
    explained: state.explained,
    attributed: fxStr(attributed),
    unattributed: actual === null ? null : fxStr(fx(actual) - attributed),
  };
  if (actual === null) return { ...base, status: 'unknown' };
  if (state.inFlight) return { ...base, status: 'in-flight' };
  if (state.explained === null) return { ...base, status: 'untracked' };
  if (state.flag) return { ...base, status: 'needs-recovery' };
  if (fx(actual) !== fx(state.explained)) return { ...base, status: 'external-change' };
  if (!fitsInside(state.legs, fx(actual))) return { ...base, status: 'over-attributed' };
  return { ...base, status: 'reconciled' };
}
