import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('reuses real TLS tunnels per origin for public books and metadata', async () => {
  const fixture = path.resolve('tests/fixtures/venue-book-proxy');
  const sockets = new Set<net.Socket>();
  const tunnels: string[] = [];
  let delayResponse = false;
  const levels = { bids: [['100', '2']], asks: [['101', '3']] };
  const origin = https.createServer({
    key: readFileSync(path.join(fixture, 'key.pem')),
    cert: readFileSync(path.join(fixture, 'cert.pem')),
  }, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const body = JSON.stringify({ ...levels, result: { b: levels.bids, a: levels.asks },
      data: [{ ctVal: '0.1', ...levels }] });
    // Keep parallel reads overlapping so each needs its own TLS tunnel.
    if (delayResponse) setTimeout(() => res.end(body), 50);
    else res.end(body);
  });
  const proxy = http.createServer();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  origin.on('connection', track);
  proxy.on('connection', track);
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = (origin.address() as net.AddressInfo).port;
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url!);
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    track(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  try {
    // A child trusts only the synthetic test CA in addition to normal roots.
    // Production TLS verification and the test runner's network guard stay intact.
    const script = `
      import { fetchVenueBook } from './src/core/estimate/books.ts';
      const books = [];
      for (const [venue, base] of [['BINANCE','ETH'],['BINANCE','ETH'],['BINANCE','BTC'],
        ['BYBIT','ETH'],['BYBIT','ETH'],['OKX','ETH']]) {
        const book = await fetchVenueBook(venue, base, 'USDT');
        books.push(book?.bids);
      }
      console.log(JSON.stringify(books));
      process.exit(0);
    `;
    const { stdout } = await run(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(), timeout: 15_000,
        env: { ...process.env, GATE_PROXY: `http://127.0.0.1:${proxyPort}`,
          NODE_EXTRA_CA_CERTS: path.join(fixture, 'cert.pem') },
      });
    expect(JSON.parse(stdout)).toEqual([
      [[100, 2]], [[100, 2]], [[100, 2]], [[100, 2]], [[100, 2]], [[100, 0.2]],
    ]);
    expect(tunnels).toEqual(['fapi.binance.com:443', 'api.bybit.com:443', 'www.okx.com:443']);
    const untrusted = await run(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `
        import { fetchVenueBook } from './src/core/estimate/books.ts';
        console.log(JSON.stringify(await fetchVenueBook('BINANCE', 'ETH', 'USDT')));
        process.exit(0);
      `], {
        cwd: process.cwd(), timeout: 10_000,
        env: { ...process.env, GATE_PROXY: `http://127.0.0.1:${proxyPort}`, NODE_EXTRA_CA_CERTS: '' },
      });
    expect(JSON.parse(untrusted.stdout)).toBeNull();
    tunnels.length = 0;
    delayResponse = true;
    const parallel = await run(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `
        import { fetchVenueBook } from './src/core/estimate/books.ts';
        const rounds = [];
        for (let round = 0; round < 3; round++) {
          rounds.push(await Promise.all(['ETH', 'BTC', 'HYPE'].map(async base =>
            (await fetchVenueBook('BINANCE', base, 'USDT'))?.bids)));
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        console.log(JSON.stringify(rounds));
        process.exit(0);
      `], {
        cwd: process.cwd(), timeout: 15_000,
        env: { ...process.env, GATE_PROXY: `http://127.0.0.1:${proxyPort}`,
          NODE_EXTRA_CA_CERTS: path.join(fixture, 'cert.pem') },
      });
    expect(JSON.parse(parallel.stdout)).toEqual(Array.from({ length: 3 }, () => [
      [[100, 2]], [[100, 2]], [[100, 2]],
    ]));
    // Nine requests need only the first three tunnels, including the third symbol.
    expect(tunnels).toEqual(Array(3).fill('fapi.binance.com:443'));
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => origin.close(() => resolve()))]);
  }
}, 20_000);
