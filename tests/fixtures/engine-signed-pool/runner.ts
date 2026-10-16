/** Local fixture child: fake credentials, synthetic TLS origin, no account access. */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { makeClients, gateProxy } from '../../../src/core/clients';
import { EngineTransport } from '../../../src/core/engine-transport';
import { gateVenue } from '../../../src/engine/venueGate';

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2]) as { maxSockets: number; endpoint?: string; mode?: string; nextProxy?: string };
  const clients = makeClients({ key: 'offline-key', secret: 'offline-secret' });
  if (input.endpoint) clients.api.basePath = input.endpoint;
  const owner = new EngineTransport(() => clients, gateProxy);
  owner.configure({ maxSockets: input.maxSockets });
  const venue = gateVenue(() => clients, fn => owner.use(fn));
  const times: number[] = [];
  let maxQueued = 0, maxConnections = 0, maxFd = 0, maxRss = 0;
  const rssStart = process.memoryUsage().rss;
  const sample = () => {
    const stats = owner.stats();
    maxQueued = Math.max(maxQueued, stats.queued);
    maxConnections = Math.max(maxConnections, stats.sockets + stats.freeSockets);
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
    if (process.platform === 'linux') maxFd = Math.max(maxFd, fs.readdirSync('/proc/self/fd').length);
  };
  const timer = setInterval(sample, 1);
  const outcomes: string[] = [];
  try {
    if (input.mode === 'proxy-switch') {
      let entered!: () => void, unblock!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { unblock = resolve; });
      const pending = owner.use(async client => {
        await client.getCrossexOrder('before');
        outcomes.push('found');
        entered();
        await wait;
        await client.getCrossexOrder('after');
        outcomes.push('found');
      });
      await started;
      process.env.GATE_PROXY = input.nextProxy!;
      outcomes.push((await venue.getOrder({ clientText: 'new-route' })).kind);
      unblock();
      await pending;
    } else if (input.mode === 'write-reset') {
      outcomes.push((await venue.create({ contract: 'OKX_ETH_USDT', side: 'BUY', qty: '0.1',
        tif: 'ioc', clientText: 'tOfflineA1', reduceOnly: false })).kind);
    } else {
      for (let round = 0; round < 2; round++) {
        await Promise.all(Array.from({ length: 8 }, async (_, n) => {
          const start = performance.now();
          const out = await venue.getOrder({ clientText: `offline${n}` });
          outcomes.push(out.kind);
          times.push(performance.now() - start);
        }));
        sample();
      }
    }
    sample();
  } finally {
    clearInterval(timer);
    await owner.close();
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ outcomes, maxQueued, maxConnections, maxFd, rssStart, maxRss,
    latencyMs: { n: times.length, p50: times[Math.ceil(times.length * .5) - 1] ?? null,
      p95: times[Math.ceil(times.length * .95) - 1] ?? null, max: times.at(-1) ?? null },
    afterClose: owner.stats(), timeoutCoverage: 'queue/CONNECT/TLS E2E UNKNOWN' }));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
