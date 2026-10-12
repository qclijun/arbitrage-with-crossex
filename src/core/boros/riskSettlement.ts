import type { BorosSettlementLedger, BorosSettlementRow } from './client';

/** Net settlement already includes fees. Validate before filtering or summing. */
export function netSettlementWindow(ledger: BorosSettlementLedger, root: string, accountId: number, throughSec: number) {
  const all = accountSettlementWindow(ledger, root, accountId, throughSec);
  const pool = root.toLowerCase() + accountId.toString(16).padStart(2, '0') + '0002ffffff';
  return { netEth: all.complete ? all.pools.find(p => p.marketAcc === pool)?.netToken ?? 0 : null,
    complete: all.complete, fromSec: all.fromSec, throughSec: all.throughSec,
    reason: all.complete ? 'Complete incremental net ETH settlement window (fees already included)' : all.reason };
}

/** All independent pools: validate the entire ledger before establishing any zero. */
export function accountSettlementWindow(ledger: BorosSettlementLedger, root: string, accountId: number, throughSec: number) {
  const fromSec = throughSec - 86400;
  const fail = (reason: string) => ({ pools: [] as Array<{ marketAcc: string; tokenId: number; netToken: number }>, complete: false, fromSec, throughSec, reason });
  if (!Number.isFinite(throughSec) || !/^0x[a-f0-9]{40}$/i.test(root) || !Number.isInteger(accountId) || accountId < 0 || accountId > 255) return fail('Invalid settlement subject or time');
  if (ledger.validationError) return fail(ledger.validationError);
  if (!Number.isFinite(ledger.coversFromSec) || ledger.coversFromSec < 0 || ledger.coversFromSec > fromSec) return fail('Settlement pages do not cover the full 24h window');
  const pool = root.toLowerCase().replace(/^0x/, '') + accountId.toString(16).padStart(2, '0') + '0002ffffff';
  const seen = new Map<string, BorosSettlementRow>();
  const totals = new Map<string, { marketAcc: string; tokenId: number; netToken: number }>();
  for (const row of ledger.rows) {
    const acc = row.marketAcc.toLowerCase().replace(/^0x/, '');
    if (!/^[a-f0-9]{52}$/.test(acc) || acc.slice(0, 40) !== pool.slice(0, 40)
      || parseInt(acc.slice(40, 42), 16) !== accountId || row.tokenId !== parseInt(acc.slice(42, 46), 16)) return fail('Foreign or malformed settlement scope');
    if (!row.id || !Number.isInteger(row.marketId) || !Number.isFinite(row.timeSec) || row.timeSec <= 0
      || !Number.isFinite(row.settlementToken) || !Number.isFinite(row.feeToken)) return fail('Malformed settlement event');
    const old = seen.get(row.id);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) return fail('Conflicting duplicate settlement event');
    if (old) continue;
    seen.set(row.id, row);
    if (row.timeSec > throughSec) return fail('Future settlement event');
    if (row.timeSec > fromSec) {
      const key = '0x' + acc;
      const total = totals.get(key) ?? { marketAcc: key, tokenId: row.tokenId!, netToken: 0 };
      total.netToken += row.settlementToken;
      if (!Number.isFinite(total.netToken)) return fail('Non-finite settlement sum');
      totals.set(key, total);
    }
  }
  return { pools: [...totals.values()], complete: true, fromSec, throughSec, reason: 'Complete incremental account net settlement window (fees already included)' };
}
