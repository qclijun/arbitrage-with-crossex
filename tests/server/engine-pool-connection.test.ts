import { createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('bounds real TLS connections, queues excess reads, verifies TLS and never retries reset writes', async () => {
  const fixture = path.resolve('tests/fixtures/engine-signed-pool');
  const sockets = new Set<net.Socket>();
  let resetWrites = false, rejectProxy = false, writes = 0, requests = 0, tunnels = 0;
  const track = (socket: net.Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  const origin = https.createServer({ key: readFileSync(path.join(fixture, 'key.pem')),
    cert: readFileSync(path.join(fixture, 'cert.pem')) }, (req, res) => {
    requests++;
    expect(req.headers.key).toBe('offline-key');
    expect(req.headers['x-gate-size-decimal']).toBe('1');
    expect(req.headers['x-gate-channel-id']).toBe('boros');
    expect(req.headers['proxy-authorization']).toBeUndefined();
    if (req.method === 'GET') {
      const payload = createHash('sha512').update('').digest('hex');
      const signature = ['GET', req.url!, '', payload, req.headers.timestamp].join('\n');
      expect(req.headers.sign).toBe(createHmac('sha512', 'offline-secret').update(signature).digest('hex'));
    }
    if (req.method === 'POST') {
      writes++;
      if (resetWrites) { req.socket.destroy(); return; }
    }
    res.setHeader('Content-Type', 'application/json');
    setTimeout(() => res.end(JSON.stringify({ order_id: '9007199254740993',
      state: 'NEW', executed_qty: '0.123456789123' })), 30);
  });
  const proxy = http.createServer();
  const secondProxy = http.createServer();
  origin.on('connection', track);
  proxy.on('connection', track);
  secondProxy.on('connection', track);
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const port = (origin.address() as net.AddressInfo).port;
  proxy.on('connect', (req, socket, head) => {
    tunnels++;
    expect(req.url).toBe('api.gateio.ws:443');
    if (rejectProxy) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    track(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  secondProxy.on('connect', proxy.listeners('connect')[0] as Parameters<typeof proxy.on>[1]);
  await new Promise<void>(resolve => secondProxy.listen(0, '127.0.0.1', resolve));
  const secondProxyPort = (secondProxy.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  const execute = async (maxSockets: number, options: { direct?: boolean; untrusted?: boolean; mode?: string; environmentProxy?: boolean } = {}) => {
    const env = { ...process.env, GATE_PROXY: options.direct ? '' : `http://127.0.0.1:${proxyPort}`,
      NODE_EXTRA_CA_CERTS: options.untrusted ? '' : path.join(fixture, 'cert.pem'),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
      NO_PROXY: '', no_proxy: '' };
    if (options.environmentProxy) {
      env.GATE_PROXY = '';
      env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
      if (options.direct) env.NO_PROXY = '127.0.0.1';
    }
    const { stdout } = await run(process.execPath, ['--import', 'tsx', path.join(fixture, 'runner.ts'),
      JSON.stringify({ maxSockets, mode: options.mode,
        nextProxy: `http://127.0.0.1:${secondProxyPort}`,
        endpoint: options.direct ? `https://127.0.0.1:${port}/api/v4` : undefined })],
    { cwd: process.cwd(), env, timeout: 20_000 });
    return JSON.parse(stdout);
  };
  try {
    const evidence = [];
    for (const maxSockets of [1, 4, 8]) {
      const start = tunnels;
      const result = await execute(maxSockets);
      expect(result.outcomes).toEqual(Array(16).fill('found'));
      expect(tunnels - start).toBe(maxSockets); // two rounds reuse the same bounded tunnels
      expect(result.maxConnections).toBeLessThanOrEqual(maxSockets);
      if (maxSockets < 8) expect(result.maxQueued).toBeGreaterThan(0);
      expect(result.afterClose.maxSockets).toBeNull();
      evidence.push({ maxSockets, ...result });
    }
    const direct = await execute(4, { direct: true });
    expect(direct.outcomes).toEqual(Array(16).fill('found'));
    const environment = await execute(4, { environmentProxy: true });
    expect(environment.outcomes).toEqual(Array(16).fill('found'));
    const beforeBypass = tunnels;
    const noProxy = await execute(4, { direct: true, environmentProxy: true });
    expect(noProxy.outcomes).toEqual(Array(16).fill('found'));
    expect(tunnels).toBe(beforeBypass);
    const beforeSwitch = tunnels;
    const switched = await execute(4, { mode: 'proxy-switch' });
    expect(switched.outcomes).toEqual(['found', 'found', 'found']);
    expect(tunnels - beforeSwitch).toBe(2); // old leased chain retains its tunnel; new work uses new proxy
    const beforeTlsFailure = requests;
    const untrusted = await execute(4, { untrusted: true });
    expect(untrusted.outcomes).toEqual(Array(16).fill('error'));
    expect(requests).toBe(beforeTlsFailure);
    resetWrites = true;
    const reset = await execute(4, { mode: 'write-reset' });
    expect(reset.outcomes).toEqual(['unknown']);
    expect(writes).toBe(1);
    rejectProxy = true;
    const beforeRejectedProxy = requests;
    const unavailable = await execute(4, { mode: 'write-reset' });
    expect(unavailable.outcomes).toEqual(['unknown']);
    expect(requests).toBe(beforeRejectedProxy); // no direct fallback
    // Synthetic local evidence only, not production connection sizing or stable RSS acceptance.
    if (process.env.ENGINE_POOL_TEST_EVIDENCE) {
      writeFileSync(process.env.ENGINE_POOL_TEST_EVIDENCE, JSON.stringify({
        version: 1, measuredUtc: new Date().toISOString(), node: process.version, scope: 'local synthetic TLS/CONNECT only',
        productionEnablement: 'UNKNOWN', steadyRssAcceptance: 'UNKNOWN', candidates: evidence,
      }, null, 2) + '\n', { mode: 0o600 });
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())),
      new Promise<void>(resolve => proxy.close(() => resolve())),
      new Promise<void>(resolve => secondProxy.close(() => resolve()))]);
  }
}, 45_000);
