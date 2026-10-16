/** Offline Store allocation diagnostic. Run from repo root with node --expose-gc --import tsx. */
const { mkWorld, A_CONTRACT } = require(require('node:path').resolve('tests/unit/engine-sim.ts'));

(async () => {
  const w = mkWorld({ target: '100', deadlineInMs: null, pricePolicy: 'best', b: { minNotional: '1' } });
  try {
    await w.step();
    for (let i = 0; i < 1200; i++) {
      if (i % 10 === 0) w.venue.fill(w.venue.liveOrder(A_CONTRACT).clientText, '0.001');
      await w.step();
      await new Promise(setImmediate);
    }
    const rows = w.store.listOrders(w.pairId).length;
    const samples = [];
    const record = (extra) => samples.push({ ...extra, rows,
      fakeOrders: w.venue.orders.size, creates: w.venue.createCalls.length,
      bestCalls: w.venue.bestQuoteCalls.length, ...process.memoryUsage() });
    const started = Date.now();
    for (let round = 0; round <= 32000; round++) {
      if (round % 200 === 0) record({ round, elapsedMs: Date.now() - started });
      if (round < 32000) {
        for (let j = 0; j < rows; j++) w.store.getPair(w.pairId);
        w.store.listOrders(w.pairId);
        await new Promise(setImmediate);
      }
    }
    global.gc(); await new Promise(setImmediate); global.gc();
    record({ gc: true });
    w.store.close();
    global.gc();
    record({ closed: true });
    const result = { node: process.version, rounds: 32000, callsPerRound: { getPair: rows, listOrders: 1 },
      method: 'Fixed 121-order in-memory Store after identical warmup; no observation and no FakeVenue calls during measurements; normal GC until final diagnostics.', samples };
    console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2));
  } catch (error) { try { w.store.close(); } catch {} throw error; }
})().catch(error => { console.error(error); process.exitCode = 1; });
