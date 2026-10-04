import type { BorosSettlementLedger, BorosSettlementRow } from './client';

/** Net settlement already includes fees. Validate before filtering or summing. */
export function netSettlementWindow(ledger: BorosSettlementLedger, root: string, accountId: number, throughSec: number) {
  const fromSec = throughSec - 86400;
  const fail = (reason: string) => ({ netEth: null, complete: false, fromSec, throughSec, reason });
  if (ledger.validationError) return fail(ledger.validationError);
  if (!Number.isFinite(ledger.coversFromSec) || ledger.coversFromSec < 0 || ledger.coversFromSec > fromSec) return fail('Settlement pages do not cover the full 24h window');
  const pool = root.toLowerCase().replace(/^0x/, '') + accountId.toString(16).padStart(2, '0') + '0002ffffff';
  const seen = new Map<string, BorosSettlementRow>();
  let net = 0;
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
    if (acc === pool && row.timeSec > fromSec) net += row.settlementToken;
  }
  return { netEth: net, complete: true, fromSec, throughSec, reason: 'Complete incremental net ETH settlement window (fees already included)' };
}
