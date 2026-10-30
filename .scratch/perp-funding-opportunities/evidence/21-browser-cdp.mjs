/** Dependency-free CDP driver for a fresh, local-only headless Chrome profile. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export async function browser(origin) {
  const profile = mkdtempSync(join(tmpdir(), 'issue21-chrome-'));
  const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps', 'about:blank'],
  { stdio: ['ignore', openSync('/tmp/issue21-chrome.log', 'a'), openSync('/tmp/issue21-chrome.log', 'a')] });
  let endpoint;
  for (let i = 0; i < 100; i++) {
    try {
      const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      endpoint = `ws://127.0.0.1:${port}${path}`; break;
    } catch { if (chrome.exitCode !== null) throw new Error(`Chrome exited ${chrome.exitCode}; see /tmp/issue21-chrome.log`); await pause(100); }
  }
  if (!endpoint) { chrome.kill(); throw new Error('Chrome did not expose CDP'); }
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const blocked = [];
  let session;
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const allowed = request.url.startsWith(origin + '/') || request.url.startsWith('data:');
      if (!allowed) blocked.push(new URL(request.url).origin);
      void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        { requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }, message.sessionId).catch(() => {});
    }
  };
  const target = await call('Target.createTarget', { url: 'about:blank' });
  session = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  const page = (method, params = {}) => call(method, params, session);
  await page('Page.enable'); await page('Runtime.enable');
  await page('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const r = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  const wait = async (expression, ms = 12_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await evaluate(`Boolean(${expression})`)) return; await pause(100); }
    throw new Error('Browser condition timed out: ' + expression);
  };
  const screenshot = async (path) => {
    await evaluate('window.scrollTo(0,0)');
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await pause(80);
    const metrics = await page('Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    const r = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, 8000), scale: 1 } });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  };
  const close = async () => {
    try { await call('Browser.close'); } catch { /* Browser may close before the response arrives. */ }
    socket.close(); if (chrome.exitCode === null) chrome.kill();
  };
  return { page, evaluate, wait, screenshot, blocked, close, pause };
}
