/** Offline paired gate. Copies the original loop into /tmp; never starts a server. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { A_CONTRACT, assertInvariants, mkWorld } from '../unit/engine-sim';

const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
async function worker(observed: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-observation-gate-'));
  const observation = observed ? new (await import('../../src/engine/observation')).EngineObservation(path.join(dir, 'evidence'), () => {}) : undefined;
  const w = mkWorld({ target: '100', deadlineInMs: null, pricePolicy: 'best', b: { minNotional: '1' }, storePath: path.join(dir, 'ledger.sqlite') });
  w.deps.observation = observation;
  const durations: number[] = [];
  const rss: number[] = [];
  const memory: ReturnType<typeof process.memoryUsage>[] = [];
  try {
    await observation?.flush(); // Steady-state gate starts after worker/storage initialization.
    await w.step();
    for (let i = 0; i < 1200; i++) {
      if (i % 10 === 0) w.venue.fill(w.venue.liveOrder(A_CONTRACT)!.clientText, '0.001');
      const start = performance.now();
      await w.step();
      // Let the async writer, retention and alert callbacks compete on the same loop.
      await new Promise(resolve => setImmediate(resolve));
      durations.push(performance.now() - start);
      if (i < 200) await new Promise(resolve => setTimeout(resolve, 1)); // Equal warm-up pacing; excluded from timing.
      if (i % 100 === 99) { const sample = process.memoryUsage(); rss.push(sample.rss); memory.push(sample); }
      assertInvariants(w);
    }
    await observation?.flush();
    // Normal-GC stability probe: fixed ledger, continued observations, no forced GC.
    const normalRss: number[] = [];
    for (let round = 0; round < 160; round++) {
      for (let i = 0; i < 200; i++) { await w.step(); await new Promise(resolve => setImmediate(resolve)); }
      await observation?.flush(); normalRss.push(process.memoryUsage().rss);
    }
    // Retained RSS is a separate diagnostic; NEVER force GC during timed ticks.
    // Freeze the ledger (no further fills), keep observing, and let native statement
    // finalizers run. Retain raw peak RSS above rather than substituting this for it.
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (!gc) throw new Error('Memory probe requires --expose-gc in the child process');
    const steadyRss: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 200; i++) { await w.step(); await new Promise(resolve => setImmediate(resolve)); }
      await observation?.flush();
      gc(); await new Promise(resolve => setImmediate(resolve)); gc();
      steadyRss.push(process.memoryUsage().rss);
    }
    const stats = observation?.stats();
    const result = { durations: durations.slice(200), rss: rss.slice(2), memory: memory.slice(2), steadyRss, normalRss, stats,
      ledger: { pair: w.store.getPair(w.pairId), orders: w.store.listOrders(w.pairId) },
      creates: w.venue.createCalls.length };
    process.stdout.write(JSON.stringify(result));
  } finally { w.store.close(); await observation?.close(); rmSync(dir, { recursive: true, force: true }); }
}

// Reanalysis can only add a veto to an existing result; it cannot turn FAIL into PASS.
function vetoLaterGrowth<T extends { pass: boolean; groups: Array<{ pass: boolean;
  selectedCheckpoint: number | null; checkpoints: Array<{ windows: number; observed: { stable: boolean } }>;
  laterObservedStable?: boolean }> }>(report: T): T {
  for (const group of report.groups) {
    group.laterObservedStable = group.selectedCheckpoint !== null && group.checkpoints
      .filter(c => c.windows >= group.selectedCheckpoint!).every(c => c.observed.stable);
    group.pass = group.pass && group.laterObservedStable;
  }
  report.pass = report.pass && report.groups.every(g => g.pass);
  return report;
}

async function main() {
  if (process.argv[2] === '--reanalyze') {
    const report = vetoLaterGrowth(JSON.parse(readFileSync(process.argv[3], 'utf8')));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.pass) process.exitCode = 1;
    return;
  }
  if (process.argv[2] === '--worker') { await worker(process.argv[3] === 'observed'); return; }
  const ref = process.argv[2];
  if (!ref) throw new Error('Supply the pre-change commit as the sole argument');
  const root = process.cwd();
  const snapshot = mkdtempSync(path.join(tmpdir(), 'engine-original-loop-'));
  try {
    mkdirSync(path.join(snapshot, 'src/core'), { recursive: true });
    mkdirSync(path.join(snapshot, 'tests/unit'), { recursive: true });
    mkdirSync(path.join(snapshot, 'tests/bench'), { recursive: true });
    cpSync(path.join(root, 'src/engine'), path.join(snapshot, 'src/engine'), { recursive: true });
    cpSync(path.join(root, 'src/core/numbers.ts'), path.join(snapshot, 'src/core/numbers.ts'));
    cpSync(path.join(root, 'tests/unit/engine-sim.ts'), path.join(snapshot, 'tests/unit/engine-sim.ts'));
    cpSync(path.join(root, 'tests/bench/engine-observation.ts'), path.join(snapshot, 'tests/bench/engine-observation.ts'));
    symlinkSync(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'));
    writeFileSync(path.join(snapshot, 'src/engine/loop.ts'), execFileSync('git', ['show', `${ref}:src/engine/loop.ts`], { cwd: root }));
    const run = (cwd: string, kind: string) => JSON.parse(execFileSync(process.execPath,
      ['--expose-gc', '--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(cwd, 'tests/bench/engine-observation.ts'), '--worker', kind],
      { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } }).toString());
    const observedSnapshot = path.join(snapshot, 'observed');
    mkdirSync(observedSnapshot);
    cpSync(path.join(snapshot, 'src'), path.join(observedSnapshot, 'src'), { recursive: true });
    cpSync(path.join(root, 'src/engine/loop.ts'), path.join(observedSnapshot, 'src/engine/loop.ts'));
    cpSync(path.join(snapshot, 'tests'), path.join(observedSnapshot, 'tests'), { recursive: true });
    symlinkSync(path.join(root, 'node_modules'), path.join(observedSnapshot, 'node_modules'));
    const groups = [];
    const baselineAll: number[] = [], observedAll: number[] = [];
    for (let group = 0; group < 3; group++) {
      // Alternate order to reduce systematic warm-cache/time-order bias.
      let base, observed;
      if (group % 2) { observed = run(observedSnapshot, 'observed'); base = run(snapshot, 'baseline'); }
      else { base = run(snapshot, 'baseline'); observed = run(observedSnapshot, 'observed'); }
      baselineAll.push(...base.durations); observedAll.push(...observed.durations);
      const baselineP95 = p95(base.durations), observedP95 = p95(observed.durations);
      const sampledMaxRssDelta = Math.max(...observed.rss) - Math.max(...base.rss);
      const stable = (samples: number[]) => {
        const middle = (samples.length - 1) / 2;
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        const numerator = samples.reduce((sum, y, i) => sum + (i - middle) * (y - mean), 0);
        const denominator = samples.reduce((sum, _, i) => sum + (i - middle) ** 2, 0);
        const slope = numerator / denominator;
        return { rangeMiB: (Math.max(...samples) - Math.min(...samples)) / 1024 / 1024,
          slopeMiBPerWindow: slope / 1024 / 1024,
          stable: Math.max(...samples) - Math.min(...samples) <= 4 * 1024 * 1024 && slope <= .25 * 1024 * 1024 };
      };
      // Predeclared checkpoints. Stop selecting at the FIRST jointly stable one,
      // even if its RSS increment fails. Never select on the size of the increment.
      const checkpoints = [80, 120, 160].map(windows => ({ windows,
        baseline: stable(base.normalRss.slice(windows - 10, windows)),
        observed: stable(observed.normalRss.slice(windows - 10, windows)) }));
      const selected = checkpoints.find(c => c.baseline.stable && c.observed.stable);
      const end = selected?.windows ?? 160;
      const baselineStability = selected?.baseline ?? checkpoints.at(-1)!.baseline;
      const observedStability = selected?.observed ?? checkpoints.at(-1)!.observed;
      const rssDelta = Math.max(...observed.normalRss.slice(end - 10, end)) - Math.max(...base.normalRss.slice(end - 10, end));
      const lateGrowth = observed.rss.at(-1) - observed.rss[Math.floor(observed.rss.length / 2)];
      const ledgerEqual = JSON.stringify(base.ledger) === JSON.stringify(observed.ledger);
      groups.push({ group: group + 1, ticks: base.durations.length, baselineP95, observedP95,
        overheadMs: observedP95 - baselineP95, budgetMs: Math.max(baselineP95 * .05, 1),
        rssDeltaMiB: rssDelta / 1024 / 1024, sampledMaxRssDeltaMiB: sampledMaxRssDelta / 1024 / 1024,
        baselineStability, observedStability, checkpoints, selectedCheckpoint: selected?.windows ?? null,
        baselineNormalRssMiB: base.normalRss.map((n: number) => n / 1024 / 1024),
        observedNormalRssMiB: observed.normalRss.map((n: number) => n / 1024 / 1024),
        baselinePostGcRssMiB: base.steadyRss.map((n: number) => n / 1024 / 1024),
        observedPostGcRssMiB: observed.steadyRss.map((n: number) => n / 1024 / 1024), lateGrowthMiB: lateGrowth / 1024 / 1024,
        baselineMemory: base.memory, observedMemory: observed.memory,
        rssSamplesMiB: observed.rss.map((v: number) => v / 1024 / 1024), ledgerEqual,
        creates: observed.creates, stats: observed.stats,
        pass: observedP95 - baselineP95 <= Math.max(baselineP95 * .05, 1) && Boolean(selected) && rssDelta <= 32 * 1024 * 1024 && ledgerEqual && observed.stats.evidence === 'COMPLETE' });
    }
    const baselineP95 = p95(baselineAll), observedP95 = p95(observedAll);
    const report = { baselineCommit: ref, node: process.version, groups, pooled: { ticks: baselineAll.length, baselineP95, observedP95,
      overheadMs: observedP95 - baselineP95, budgetMs: Math.max(baselineP95 * .05, 1) },
      pass: groups.every(g => g.pass) && observedP95 - baselineP95 <= Math.max(baselineP95 * .05, 1),
      limitations: 'Timed ticks use normal GC and include writer contention. Normal-GC RSS runs 160 x 200 fixed-ledger ticks. Predeclared checkpoints 80/120/160 use the last 10 windows: both configurations require range <=4MiB and positive OLS slope <=0.25MiB/window. Use ONLY the first jointly stable checkpoint, independently of RSS increment; no joint stability means unverified/fail. The <=32MiB gate compares maxima of those windows. Post-GC samples are diagnostic only. Timed RSS maxima are sampled every 100 ticks, not true process peaks. RSS includes workers. Finite tests cannot prove absence of all future growth; bounded queue/cache and repeated-batch regression provide structural evidence. No live latency/exposure improvement claim.' };
    vetoLaterGrowth(report);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.pass) process.exitCode = 1;
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}
void main();
