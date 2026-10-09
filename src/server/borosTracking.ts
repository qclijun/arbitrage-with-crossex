import type { BorosTxn } from '../core/boros/client';

const integer = (s: string): bigint | null => {
  // Some older responses/fixtures serialize raw integers in scientific
  // notation. Expand the digits exactly rather than round through Number.
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) return null;
  const digits = m[2] + (m[3] ?? '');
  const shift = Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 1000) return null;
  if (shift < 0 && !digits.endsWith('0'.repeat(-shift))) return null;
  const expanded = shift < 0 ? digits.slice(0, shift) || '0' : digits + '0'.repeat(shift);
  return BigInt(m[1] + expanded);
};

export const borosFeesKnown = (txns: BorosTxn[]): boolean =>
  txns.every((t) => integer(t.fee) !== null && integer(t.pnl) !== null);

/** Follow the venue's exact position chain backwards, including same-second
 * fills. An older occurrence of the same size is not evidence of today's run. */
export function currentBorosCycle(txns: BorosTxn[], position: string, complete: boolean):
  { openedSec: number; txns: Set<BorosTxn> } | null {
  const initial = integer(position);
  if (!complete || initial === null || initial === 0n) return null;
  let size: bigint = initial;
  const rows = txns.map((t) => ({ txn: t, time: t.time, prev: integer(t.prevPositionS), post: integer(t.postPositionS) }));
  const current = new Set<BorosTxn>();
  if (rows.some((t) => t.prev === null || t.post === null || !Number.isSafeInteger(t.time) || t.time <= 0)) return null;
  while (rows.length) {
    const newest = Math.max(...rows.map((t) => t.time));
    const matches = rows.filter((t) => t.time === newest && t.post === size);
    if (matches.length !== 1) return null;
    const row = matches[0];
    current.add(row.txn);
    if (row.prev === 0n || (row.prev! > 0n) !== (size > 0n)) return { openedSec: row.time, txns: current };
    size = row.prev!;
    rows.splice(rows.indexOf(row), 1);
  }
  return null;
}
