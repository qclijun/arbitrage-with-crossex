/**
 * The ledger version marker: a file beside the ledger that installers read to
 * decide whether rolling back to an older program is allowed. An app
 * directory's `ledger-support.json` declares the newest version that program
 * can run on. The SQLite header stays the authority; this is its echo for
 * tools that cannot open the ledger.
 */
import path from 'node:path';
import { writeJsonOwnerOnly } from './backup';

export const LEDGER_MARKER = 'ledger-version.json';

export function writeLedgerMarker(ledgerFile: string | null, version: number): void {
  if (ledgerFile) writeJsonOwnerOnly(path.join(path.dirname(ledgerFile), LEDGER_MARKER), { version });
}
