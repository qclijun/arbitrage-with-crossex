import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isSupportedCoin } from '../core/coins';
import { parseSymbol } from '../core/numbers';
import { readOwnerJson, writeOwnerOnlyJson } from './secretFile';

export interface TrackingStart {
  userId: string;
  firstOpenMs: number;
}

function parseStart(raw: unknown): TrackingStart | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.userId !== 'string' || typeof r.firstOpenMs !== 'number' || !(r.firstOpenMs > 0)) return null;
  return { userId: r.userId, firstOpenMs: r.firstOpenMs };
}

export class TrackingStartFile {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'tracking-start.json');
  }

  read(): TrackingStart | null {
    return readOwnerJson(this.file, parseStart);
  }

  write(start: TrackingStart): void {
    writeOwnerOnlyJson(this.file, start);
  }

  private scopeFile(userId: string, address: string): string {
    const key = createHash('sha256').update(JSON.stringify([userId, address.toLowerCase()])).digest('hex');
    return path.join(path.dirname(this.file), `tracking-start-${key}.json`);
  }

  readScope(userId: string, address: string): (TrackingStart & { gateFirstOpenMs: number }) | null {
    return readOwnerJson(this.scopeFile(userId, address), (raw) => {
      const start = parseStart(raw);
      const gate = (raw as { gateFirstOpenMs?: unknown } | null)?.gateFirstOpenMs;
      return start && start.userId === userId && typeof gate === 'number' && Number.isFinite(gate) && gate > 0
        ? { ...start, gateFirstOpenMs: gate } : null;
    });
  }

  writeScope(address: string, start: TrackingStart & { gateFirstOpenMs: number }): void {
    writeOwnerOnlyJson(this.scopeFile(start.userId, address), start);
  }
}

export function earliestSupportedOpenMs(rows: Array<{ symbol?: string; createTime?: string }>): number | null {
  let earliest: number | null = null;
  for (const row of rows) {
    if (!isSupportedCoin(parseSymbol(row.symbol ?? '').base)) continue;
    const n = Number(row.createTime);
    if (!Number.isFinite(n) || n <= 0) continue;
    const ms = n < 1e12 ? n * 1000 : n;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}
