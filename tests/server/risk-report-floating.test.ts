/**
 * The shared Risk report applies only proven floating two-leg quantity to the
 * Boros coverage checks, and hands the same exemption to the monitor in its
 * version-2 collection (ticket 16).
 */
import { rmSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST } from './helpers/gate-nock';
import { buildRiskReportApp } from './helpers/risk-report-fixture';

let app: FastifyInstance | undefined;
let tempDataDir: string | undefined;
afterEach(async () => {
  await app?.close();
  if (tempDataDir) rmSync(tempDataDir, { recursive: true, force: true });
  app = tempDataDir = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture() {
  const built = await buildRiskReportApp();
  app = built.app;
  tempDataDir = built.tempDataDir;
  return built;
}
const readReport = async (f: Awaited<ReturnType<typeof fixture>>) => (await app!.inject({ url: f.url, headers: HOST })).json().data;
const metric = (r: any, id: string) => r.checks.flatMap((c: any) => Object.entries(c.metrics)).find(([k]: any) => k === id)?.[1] as any;

describe('floating applicability in the shared Risk report', () => {
  it('drops the Boros requirement only for proven floating two-leg quantity, and carries it to the monitor', async () => {
    const f = await fixture(), s = f.snapshots;
    s.asset.risk.positions = [];
    let r = await readReport(f);
    expect(r.version).toBe(2);
    expect(metric(r, 'hedge.funding_unmatched').value).toBe(true);
    expect(r.collection.fundingApplicability).toEqual([]);
    const legs = s.positions.exposure[0].legs;
    s.slices = { slices: [{ id: 'F', kind: 'funding-two-leg', source: {}, createdAt: 1, reducible: {}, legs: [
      { leg: 'long', account: 'crossex', contract: legs[1].symbol, side: 'long', unit: 'base', qty: '3' },
      { leg: 'short', account: 'crossex', contract: legs[0].symbol, side: 'short', unit: 'base', qty: '3' },
    ] }], contracts: s.positions.positions.map((p: any) => ({ contract: p.symbol, status: 'reconciled', unknown: false, actual: p.positionQty })) };
    r = await readReport(f);
    expect(metric(r, 'hedge.funding_unmatched').value).toBe(false);
    expect(r.checks.find((c: any) => c.id === 'hedge.hl_size_gap_eth').status).toBe('OK');
    expect(r.collection.fundingApplicability.map((g: any) => [g.symbol, g.side, g.qty])).toEqual([
      [legs[1].symbol, 'LONG', '3'], [legs[0].symbol, 'SHORT', '3'],
    ]);
  });
  it('keeps a report complete without slice evidence, stating the exemption as UNKNOWN', async () => {
    const f = await fixture();
    f.failed.add('slices');
    const r = await readReport(f);
    expect(r.complete).toBe(true);
    expect(r.errors).toEqual({});
    expect(r.collection.fundingApplicability).toBeNull();
    expect(r.checks.find((c: any) => c.id === 'data.stale')?.status ?? 'OK').not.toBe('WARNING');
  });
});
