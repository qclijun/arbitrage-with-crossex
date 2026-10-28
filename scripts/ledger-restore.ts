/**
 * Restore the backup the latest ledger upgrade took, and only while the
 * upgraded ledger has not been written since (src/engine/ledger/restore.ts).
 * Stop the server first. Restoring does not make an older program safe on
 * a newer ledger; it puts back the older ledger, keeping the replaced one.
 *
 *   yarn ledger:restore <data-dir>/ledger-backups/<backup>.sqlite
 *
 * The data directory is ARB_DATA_DIR, or ./data in a source checkout.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreLedgerBackup } from '../src/engine/ledger/restore';
import { LedgerRefusal } from '../src/engine/ledger/version';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.ARB_DATA_DIR ? path.resolve(process.env.ARB_DATA_DIR) : path.join(repoRoot, 'data');
const backupFile = process.argv[2];
if (!backupFile) {
  console.error('usage: yarn ledger:restore <path to a ledger-backups/*.sqlite file>');
  process.exit(2);
}

try {
  const result = restoreLedgerBackup({
    ledgerFile: path.join(dataDir, 'deals.sqlite'),
    backupFile: path.resolve(backupFile),
    now: Date.now(),
  });
  console.log(`Restored ledger version ${result.version}. The replaced ledger is kept at ${result.replacedFile}.`);
} catch (err) {
  if (!(err instanceof LedgerRefusal)) throw err;
  console.error(`Refused (${err.code}): ${err.message}`);
  process.exit(1);
}
