import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { rolloverWatchProfile as p, watchProgress, watchPreview, nextWatchProbe, watchRequest, type WatchSimulation } from '../../src/core/rolloverWatch';
import type { RiskBorosPosition } from '../../src/core/risk';

const now = 1792280000;
function positions(rolled = 0): RiskBorosPosition[] {
  return p.legs.flatMap(l => [{ marketAcc: p.address + '000002ffffff', base: 'ETH', tokenId: 2,
    marketId: l.marketId, venue: l.venue, side: l.side, sizeToken: p.totalSize - rolled,
    maturity: p.oldMaturity, entryApr: l.entryApr }, ...(rolled ? [{ marketAcc: p.address + '000002ffffff', base: 'ETH', tokenId: 2,
      marketId: l.targetId, venue: l.venue, side: l.side, sizeToken: rolled, maturity: p.newMaturity, entryApr: .05 }] : [])]) as RiskBorosPosition[];
}
function simulation(size = 1): WatchSimulation {
  const req = watchRequest(p.address, size);
  const legs = [...req.exit.legs, ...req.entry.legs].map((l, i) => ({ ...l, venue: p.legs[i % 2].venue,
    base: 'ETH', bookStatus: 'ok', midApr: .06, execApr: .06, sizeWithinTolerance: 1.98,
    sizing: { deltaSize: l.direction === 'short' ? -size : size, orderSide: l.direction } }));
  return { simulatedAtMs: now * 1000, gasBalanceUsd: 5,
    exit: { simulation: { legs: legs.slice(0, 2), collateral: 'ETH', secondsToMaturity: p.oldMaturity - now } },
    entry: { simulation: { legs: legs.slice(2), collateral: 'ETH', secondsToMaturity: p.newMaturity - now } },
    gate: { blockers: [], warnings: [], margin: { need: .01, availableAfter: .1, availableAfterExit: .11, shortfall: 0 } },
    venue: { status: 'Succeed', orders: legs.map((l, i) => ({ marketId: l.marketId, action: i < 2 ? 'close' : 'open', filled: true, matchedSize: size, error: null })) },
  } as unknown as WatchSimulation;
}
const attempt = (fn: () => unknown) => { try { return { result: fn() }; } catch { return { error: true }; } };
function python(input: unknown) {
  const code = `import json,sys
sys.path.insert(0,'scripts')
from rollover_batch import progress,preview,next_probe,roll_request
v=json.loads(sys.argv[1]);out=[]
for c in v:
 try:
  f={'progress':progress,'preview':preview,'probe':next_probe,'request':roll_request}[c['kind']]
  out.append({'result':f(*c['args'])})
 except Exception: out.append({'error':True})
print(json.dumps(out))`;
  const r = spawnSync('python3', ['-c', code, JSON.stringify(input)], { encoding: 'utf8', timeout: 10000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
describe('watch-profile Python / Risk policy parity', () => {
  it('matches progress, completed/imbalanced positions, preview failures and bounded probe sizes', () => {
    const scenarios: Array<{ kind: string; args: unknown[] }> = [0, 1, p.totalSize].map(q => ({ kind: 'progress', args: [positions(q)] }));
    scenarios.push({ kind: 'progress', args: [[]] });
    const broken = positions(1); broken[0].sizeToken -= .1;
    scenarios.push({ kind: 'progress', args: [broken] });
    const wrongPool = positions(); wrongPool[0].marketAcc = p.address + '010002ffffff';
    scenarios.push({ kind: 'progress', args: [wrongPool] });
    for (const kind of ['ok', 'refused', 'partial', 'missing-after', 'missing-gas', 'over-tolerance', 'future', 'expired']) {
      const s = simulation();
      if (kind === 'refused') s.venue!.status = 'Refused';
      if (kind === 'partial') s.venue!.orders[0].matchedSize = .5;
      if (kind === 'missing-after') s.gate.margin.availableAfter = null;
      if (kind === 'missing-gas') s.gasBalanceUsd = null;
      if (kind === 'over-tolerance') s.entry.simulation.legs[0].execApr = .07;
      if (kind === 'future') s.simulatedAtMs += 1000;
      if (kind === 'expired') s.simulatedAtMs -= 121000;
      scenarios.push({ kind: 'preview', args: [s, 1, now] });
    }
    for (const args of [[1.9801178, null, 2500], [2, 1, 2500], [.001, null, 2500], [1, null, null]]) scenarios.push({ kind: 'probe', args });
    scenarios.push({ kind: 'request', args: [p.address, 1.25] });
    const reference = python(scenarios);
    const actual = scenarios.map(c => attempt(() => c.kind === 'progress' ? watchProgress(c.args[0] as RiskBorosPosition[])
      : c.kind === 'preview' ? watchPreview(c.args[0] as WatchSimulation, c.args[1] as number, c.args[2] as number)
      : c.kind === 'probe' ? nextWatchProbe(c.args[0] as number, c.args[1] as number | null, c.args[2] as number | null)
      : watchRequest(c.args[0] as string, c.args[1] as number)));
    expect(actual).toEqual(reference);
  });
});
