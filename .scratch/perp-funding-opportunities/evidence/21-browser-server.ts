/** Manual browser fixture. Production app via inject; no venue network or real ledger. */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import nock from 'nock';
import { integratedFundingWorld } from '../../../tests/helpers/funding-integrated-fixture';
import { HOST, TEST_TOKEN } from '../../../tests/server/helpers/gate-nock';
import { LONG_SYMBOL, SHORT_SYMBOL } from '../../../tests/helpers/funding-intent-fixture';
import { tickPair } from '../../../src/engine/loop';
import { fx, fxStr } from '../../../src/engine/fx';
import { NOW } from '../../../tests/helpers/funding-ranking-fixture';

async function main() {
  nock.disableNetConnect();
  globalThis.fetch = async () => { throw new Error('fixture: external fetch blocked'); };
  const realNow = Date.now.bind(Date);
  let offsetMs = NOW - realNow();
  // The app's envelope/cache clocks must agree with the injected engine clock.
  // This process contains only synthetic data; production time is never changed.
  Date.now = () => realNow() + offsetMs;
  const w = await integratedFundingWorld();
  const legacy = await import('../../../web/src/test/fixtures');
  const legacyRows = legacy.makeOpportunitiesResult({ groups: [legacy.makeOpportunityGroup({ maturity: Math.floor(w.clock.now() / 1000) + 30 * 86400 }), legacy.makeOpportunityGroup({
    tokenId: 2, collateral: 'ETH', collateralPriceUsd: 1900, maturity: Math.floor(w.clock.now() / 1000) + 50 * 86400,
    secondsToMaturity: legacy.SPREAD_OPP_MATURITY - legacy.SPREAD_OPP_NOW, pairs: [legacy.makeSpreadOpportunityPair()],
  })] });
  const calls: Array<{ method: string; path: string; status: number; intentId?: string; previewId?: string; returnedPreviewId?: string; dealId?: string; responseDropped?: boolean }> = [];
  const blocked: string[] = [];
  let dropNextAcceptance = false;
  const dist = resolve('web/dist');
  const sync = () => { w.clock.t = Math.max(w.clock.now(), realNow() + offsetMs); };
  const status = () => ({ now: w.clock.now(), admission: w.store.admission.read(),
    deals: w.store.listPairs().map((p) => ({ id: p.id, mode: p.mode, deadlineAt: p.deadlineAt })),
    createCalls: w.venue.createCalls, calls, blocked });
  const tick = async (id: string, count: number) => {
    for (let i = 0; i < count; i++) { await tickPair(w, id); w.clock.advance(1000); }
    offsetMs = w.clock.now() - realNow();
  };
  // Only this fake account is visible through slice/position HTTP reads.
  nock('https://api.gateio.ws').persist().get('/api/v4/crossex/positions').query(true).reply(() => [200,
    w.state.positions.map((p) => ({ symbol: p.symbol, position_qty: p.positionQty, position_side: 'SINGLE', mark_price: '2500',
      entry_price: '2500', position_value: fxStr(fx(p.positionQty) * 2500n), leverage: '5', max_leverage: '50', upnl: '0', upnl_rate: '0',
      funding_fee: '0', fee: '0', initial_margin: '25', maintenance_margin: '5' }))]);
  nock('https://api.gateio.ws').persist().get('/api/v4/crossex/rule/symbols').query(true).reply(() => [200,
    w.state.rules.map((r) => ({ symbol: r.symbol, state: 'live', business_type: 'FUTURE', lot_size: r.lotSize,
      min_size: r.minSize, min_notional: r.minNotional, tick_size: r.tickSize, max_market_size: r.maxMarketSize, max_limit_size: r.maxLimitSize }))]);
  let origin = '';
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
        res.writeHead(403); res.end('fixture origin refused'); return;
      }
      sync();
      const url = new URL(req.url ?? '/', origin);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const json = (data: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname === '/__fixture/status') { json(status()); return; }
      if (url.pathname === '/__fixture/action' && req.method === 'POST') {
        const { kind } = JSON.parse(raw);
        if (kind === 'enable' || kind === 'close') await w.post('/api/admission', { open: kind === 'enable' });
        else if (kind === 'lose-response') dropNextAcceptance = true;
        else if (kind === 'reprice') w.state.fees.find((f) => f.exchangeType === 'HYPERLIQUID')!.futureMakerFee = '0.0002';
        else if (kind === 'stale') {
          w.clock.advance(3_600_000); offsetMs = w.clock.now() - realNow();
          w.history.publish(null, { startedAt: w.clock.now(), finishedAt: w.clock.now(), cutoff: Math.floor(w.clock.now() / 3_600_000) * 3_600_000,
            outcome: 'failed', reason: 'round-error', requests: 0, venues: {} });
        } else {
          const deal = w.store.listPairs().find((p) => p.mode !== 'DONE');
          if (!deal) throw new Error('no active synthetic deal');
          if (kind === 'maker') await tick(deal.id, 3);
          else if (kind === 'partial') {
            const maker = w.venue.liveOrder(LONG_SYMBOL);
            if (!maker) throw new Error('no synthetic maker');
            w.venue.fill(maker.clientText, '0.05'); await tick(deal.id, 2);
          } else if (kind === 'finish') {
            await tick(deal.id, 6);
          } else throw new Error('unknown fixture action');
          const truth = w.venue.truth();
          w.state.positions = [{ symbol: LONG_SYMBOL, positionQty: fxStr(truth.aTrue) }, { symbol: SHORT_SYMBOL, positionQty: fxStr(-truth.bTrue) }];
        }
        json(status()); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-arb-token'] !== TEST_TOKEN) {
          json({ ok: false, error: { category: 'unauthorized', message: 'Fixture token required', retryable: false } }, 401);
          return;
        }
        // Keep initial chrome/setup data synthetic. Everything not explicitly
        // needed below fails locally rather than invoking unrelated adapters.
        const bootstrap: Record<string, unknown> = {
          '/api/credentials': { configured: true, keyMasked: 'SYNTHETIC', identity: 'ticket21-fixture' },
          '/api/version': { current: '9.9.9-fixture', latest: null, updateAvailable: false },
          '/api/disclaimer': { version: 'fixture', accepted: true, acceptedVersion: 'fixture' },
          '/api/account': { marginBalance: '10000', initialMargin: '100', maintenanceMargin: '50', assets: [], upnl: '0' },
          '/api/orders/open': [], '/api/alerts': [],
          '/api/boros/agent': legacy.agentStatus(), '/api/telegram': { configured: false },
          '/api/opportunities': legacyRows,
          '/api/risk/evidence': { scope: { credentialId: 'ticket21-fixture', address: null }, metrics: {}, baseline: null, fundingGapStartedAt: null },
        };
        if (url.pathname in bootstrap) { json({ ok: true, data: bootstrap[url.pathname], meta: { ts: w.clock.now() } }); return; }
        if (!/^\/api\/(funding\/|admission(?:$|\/)|deals(?:$|\/)|slices(?:$|\/)|positions$)/.test(url.pathname)) {
          calls.push({ method: req.method ?? 'GET', path: url.pathname, status: 503 });
          json({ ok: false, error: { category: 'not-configured', message: 'Unavailable in isolated ticket21 fixture', retryable: false } }, 503); return;
        }
        const headers = { ...req.headers, host: HOST.host, ...(req.headers.origin ? { origin: 'http://localhost:6688' } : {}) };
        const response = await w.app.inject({ method: req.method as 'GET' | 'POST', url: req.url!, headers,
          ...(raw ? { payload: raw } : {}) });
        const sent = raw ? JSON.parse(raw) : {};
        const result = response.json();
        const dropped = url.pathname === '/api/funding/intents' && req.method === 'POST' && response.statusCode === 202 && dropNextAcceptance;
        calls.push({ method: req.method ?? 'GET', path: req.url!, status: response.statusCode,
          ...(sent.intentId ? { intentId: sent.intentId, previewId: sent.previewId } : {}),
          ...(result.data?.previewId || result.preview?.previewId ? { returnedPreviewId: result.data?.previewId ?? result.preview?.previewId } : {}),
          ...(result.data?.dealId ? { dealId: result.data.dealId } : {}), ...(dropped ? { responseDropped: true } : {}) });
        if (dropped) {
          // Deliver the status then truncate the body: an empty reused TCP
          // connection can be retried by Chrome below the application's fetch.
          dropNextAcceptance = false;
          res.writeHead(response.statusCode, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(response.body)) });
          res.write('{"ok":'); setTimeout(() => res.destroy(), 30); return;
        }
        res.writeHead(response.statusCode, { 'content-type': 'application/json' }); res.end(response.body); return;
      }
      const file = resolve(dist, '.' + url.pathname);
      if (file !== dist && !file.startsWith(dist + '/')) { res.writeHead(403); res.end(); return; }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const prelude = `<script>const realNow=Date.now.bind(Date);Date.now=()=>realNow()+${offsetMs};
          const originalFetch=window.fetch.bind(window);window.__ticket21Requests=[];
          window.fetch=(url,init)=>{const path=new URL(typeof url==='string'?url:url.url,location.href).pathname;
            if(path.startsWith('/api/funding/')){let body={};try{body=JSON.parse(init?.body||'{}')}catch{}
              window.__ticket21Requests.push({path,method:init?.method||'GET',intentId:body.intentId,previewId:body.previewId})}
            return originalFetch(url,init)};</script>`;
        const html = readFileSync(resolve(dist, 'index.html'), 'utf8').replace('__ARB_TOKEN__', TEST_TOKEN).replace('</head>', prelude + '</head>');
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(html); return;
      }
      const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
    } catch (error) {
      blocked.push(error instanceof Error ? error.message : 'fixture error');
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { category: 'fixture', message: 'fixture request failed', retryable: false } }));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  writeFileSync('/tmp/issue21-browser-context.json', JSON.stringify({ origin, offsetMs, fixture: 'synthetic; no live services' }) + '\n');
  console.log(JSON.stringify({ origin }));
  const close = () => {
    writeFileSync('/tmp/issue21-browser-server-evidence.json', JSON.stringify(status(), null, 2) + '\n');
    server.closeAllConnections(); server.close(); void w.app.close().finally(() => { w.store.close(); process.exit(0); });
  };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
