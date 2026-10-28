/**
 * Restore the backup the latest ledger upgrade took, and only while the
 * upgraded ledger has not been written since (src/engine/ledger/restore.ts).
 * Stop the server first. The ledger restored is the one the backup sits
 * beside; the replaced one is kept. Restoring puts back an older ledger — it
 * does not make an older program safe on a newer one.
 *
 *   yarn ledger:restore <data-dir>/ledger-backups/<backup>.sqlite
 */
import path from 'node:path';
import { restoreLedgerBackup } from '../src/engine/ledger/restore';
import { LedgerRefusal } from '../src/engine/ledger/version';

const backupFile = process.argv[2];
if (!backupFile) {
  console.error('usage: yarn ledger:restore <path to a ledger-backups/*.sqlite file>');
  process.exit(2);
}

try {
  const result = restoreLedgerBackup({ backupFile: path.resolve(backupFile), now: Date.now() });
  console.log(`Restored ledger version ${result.version}. The replaced ledger is kept at ${result.replacedFile}.`);
} catch (err) {
  if (!(err instanceof LedgerRefusal)) throw err;
  console.error(`Refused (${err.code}): ${err.message}`);
  process.exit(1);
}
