/**
 * Signed net position per contract from a fresh /crossex/positions read, for
 * the slice ledger's gates and reconciliation. The venue's positionSide wins
 * over the size's sign (as core/orders.ts direction does), rows for the same
 * contract are summed, and a body that is not a list — or a size that is not
 * a plain decimal — is unreadable, never zero.
 */
import type { Clients } from '../core/clients';
import { direction } from '../core/orders';
import { fx, fxStr } from '../engine/fx';

export function signedPositions(body: unknown): Map<string, string> {
  if (!Array.isArray(body)) throw new Error('positions came back unreadable');
  const sums = new Map<string, bigint>();
  for (const p of body as Array<{ symbol?: string; positionQty?: unknown; positionSide?: string }>) {
    const raw = fx(String(p.positionQty ?? '0'));
    const size = raw < 0n ? -raw : raw;
    const contract = (p.symbol ?? '').toUpperCase();
    const signed = direction(p.positionSide, fxStr(raw)) === 'SHORT' ? -size : size;
    sums.set(contract, (sums.get(contract) ?? 0n) + signed);
  }
  return new Map([...sums].map(([c, v]) => [c, fxStr(v)]));
}

export async function readSignedPositions(clients: Clients): Promise<Map<string, string>> {
  return signedPositions((await clients.crossEx.listCrossexPositions()).body as unknown);
}
