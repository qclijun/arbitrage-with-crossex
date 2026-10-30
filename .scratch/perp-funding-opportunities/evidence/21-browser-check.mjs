/** Formal production-bundle browser acceptance; all responses are isolated fixture data. */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { browser } from './21-browser-cdp.mjs';

const base = '.scratch/perp-funding-opportunities/evidence/';
const root = base + '21-browser-runs/' + new Date().toISOString().replace(/[:.]/g, '-') + '/';
mkdirSync(root, { recursive: true });
const fixture = spawn('yarn', ['tsx', base + '21-browser-server.ts'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const origin = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { process.kill(-fixture.pid, 'SIGTERM'); reject(new Error('fixture startup timed out')); }, 20_000);
  let buffer = '';
  fixture.stdout.on('data', chunk => {
    appendFileSync(root + 'server.log', chunk); buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) if (line.startsWith('{')) { const value = JSON.parse(line); if (value.origin) { clearTimeout(timer); resolve(value.origin); } }
  });
  fixture.stderr.on('data', chunk => appendFileSync(root + 'server.log', chunk));
  fixture.on('exit', code => { clearTimeout(timer); reject(new Error('fixture exited ' + code)); });
});
let b;
const evidence = { fixture: origin, steps: [], blockedExternalRequests: [] };
const text = () => b.evaluate('document.body.innerText');
const status = () => fetch(origin + '/__fixture/status').then(r => r.json());
const action = kind => fetch(origin + '/__fixture/action', { method: 'POST', body: JSON.stringify({ kind }) }).then(r => r.json());
const posts = s => s.calls.filter(x => x.method === 'POST' && x.path === '/api/funding/intents');
const click = async label => {
  const ok = await b.evaluate(`(()=>{const x=[...document.querySelectorAll('button')].find(x=>x.getClientRects().length&&x.innerText.trim()===${JSON.stringify(label)});if(!x||x.disabled)return false;x.click();return true})()`);
  assert.ok(ok, 'visible button missing: ' + label); await b.pause(80);
};
const fill = async (label, value) => {
  const selector = `input[aria-label=${JSON.stringify(label)}]`;
  assert.ok(await b.evaluate(`(()=>{const x=document.querySelector(${JSON.stringify(selector)});if(!x||!x.getClientRects().length)return false;x.focus();x.select();return document.activeElement===x})()`), label);
  await b.page('Input.insertText', { text: value });
};
const shot = async name => {
  await b.evaluate(`[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Not now'&&x.getClientRects().length)?.click()`);
  await b.screenshot(root + name + '.png');
  evidence.steps.push({ name, wallAt: new Date().toISOString(), pageNow: await b.evaluate('Date.now()'), requests: await b.evaluate('window.__ticket21Requests'), text: (await text()).slice(-6500) });
};
const reload = async () => {
  await b.page('Page.reload'); await b.wait(`document.body?.innerText.includes('Funding Spreads')`);
  await click('Funding Spreads');
  await b.wait(`document.querySelector('[aria-label="Candidate detail"]')?.getClientRects().length`); await b.pause(100);
};
const acknowledge = () => b.evaluate(`(()=>{for(const x of document.querySelectorAll('[aria-label="Open this pair"] input[type=checkbox]'))if(!x.checked)x.click()})()`);
const hold = async ms => {
  const point = await b.evaluate(`(()=>{const x=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Hold to open'&&x.getClientRects().length);if(!x||x.disabled)return null;x.scrollIntoView({block:'center'});const r=x.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(point, 'hold button must be enabled');
  await b.page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await b.pause(ms);
  await b.page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
};
try {
  evidence.authChecks = [];
  for (const path of ['/api/credentials', '/api/account', '/api/funding/opportunities']) {
    for (const token of [null, 'incorrect-fixture-token']) {
      const response = await fetch(origin + path, { headers: token ? { 'x-arb-token': token } : {} });
      evidence.authChecks.push({ path, token: token ? 'incorrect' : 'missing', status: response.status });
      assert.equal(response.status, 401, path + ' must require the fixture token');
    }
  }
  b = await browser(origin); evidence.blockedExternalRequests = b.blocked;
  await b.page('Page.navigate', { url: origin + '/?tab=funding' });
  await b.wait(`document.querySelector('[aria-label="Candidate detail"]')`);
  assert.match(await text(), /Manual opening is not enabled/);
  await shot('21-browser-observation');
  await b.evaluate(`(()=>{const x=[...document.querySelectorAll('label')].find(x=>x.textContent.includes('Positive spread only'));x.querySelector('input').click()})()`);
  await b.wait(`document.body.innerText.includes('1 of 2 pairs')`);
  await shot('21-browser-filtered');
  await action('enable'); await reload();
  await b.wait(`!document.body.innerText.includes('Manual opening is not enabled')`);
  await b.evaluate(`document.querySelector('input[aria-label="Maker: long HYPERLIQUID"]').click()`);
  for (const [label, value] of [['Quantity (ETH)','0.15'],['Short leverage','3'],['Long leverage','5'],['Maker price','2499.9'],['Hold days','30']]) await fill(label,value);
  await click('Preview'); await b.wait(`document.body.innerText.includes('I authorize converting')`);
  await shot('21-browser-preview');
  await fill('Quantity (ETH)', '0.16');
  assert.ok(!(await text()).includes('I authorize converting'), 'editing must discard confirmation');
  await fill('Quantity (ETH)', '0.15'); await click('Preview');
  await b.wait(`document.body.innerText.includes('I authorize converting')`);
  await acknowledge(); await b.pause(80); await hold(300); await b.pause(150);
  assert.equal(posts(await status()).length, 0, 'a cancelled short hold must not send');
  await action('reprice'); await hold(900);
  await b.wait(`document.body.innerText.includes('confirm the new preview')`);
  assert.equal((await status()).deals.length, 0, 'a changed preview must not execute');
  assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('[aria-label="Open this pair"] input[type=checkbox]')].map(x=>x.checked)`), [false,false]);
  await shot('21-browser-reconfirm');
  await acknowledge(); await action('lose-response'); await b.pause(80); await hold(900);
  await b.wait(`document.body.innerText.includes('Accepted as intent')`);
  let s = await status(); assert.equal(s.deals.length, 1); assert.equal(posts(s).length, 2); assert.ok(posts(s)[1].responseDropped);
  const browserPosts = await b.evaluate(`window.__ticket21Requests.filter(x=>x.method==='POST'&&x.path==='/api/funding/intents')`);
  assert.equal(browserPosts.length, 2); assert.equal(browserPosts[1].intentId, posts(s)[1].intentId);
  assert.notEqual(posts(s)[0].previewId, posts(s)[1].previewId, 'reconfirmation must bind the new preview');
  await shot('21-browser-recovered');
  const dealId = s.deals[0].id;
  await action('maker'); await action('partial'); await action('close'); await reload();
  await b.wait(`document.body.innerText.includes('Accepted as intent')&&document.querySelector('table[aria-label="Deal"]')?.innerText.includes('0.05')`);
  assert.equal((await status()).deals[0].id, dealId); assert.equal(posts(await status()).length, 2, 'refresh must look up, never resend');
  await shot('21-browser-restored-partial');
  await click('Open the deal view'); await b.wait(`!![...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Stop'&&x.getClientRects().length)`);
  await click('Stop'); await action('finish'); await b.pause(1200);
  await shot('21-browser-stopped');
  await b.page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await b.page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await reload(); await b.wait(`document.querySelector('table[aria-label="Deal"]')?.innerText.includes('DONE')`);
  assert.equal((await status()).createCalls.length, 2, 'Stop must leave the residual unbought');
  await shot('21-browser-terminal');
  await click('Go to Positions'); await b.pause(350); await click('Strategy ownership');
  await b.wait(`document.body.innerText.includes('0.05')`);
  await b.evaluate(`[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Not now'&&x.getClientRects().length)?.click()`);
  await shot('21-browser-positions');
  await b.page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await b.page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await click('Risk'); await b.wait(`document.body.innerText.includes('Incomplete / unknown evidence')`); await shot('21-browser-risk');
  await click('Opportunities'); await b.wait(`!![...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')?.startsWith('Show details for'))`);
  await b.evaluate(`(()=>{for(const x of document.querySelectorAll('button'))if(x.getAttribute('aria-label')?.startsWith('Show details for'))x.click()})()`);
  await b.pause(250); assert.match(await text(), /four legs/); assert.match(await text(), /three legs/); await shot('21-browser-legacy-entries');
  assert.ok(await b.evaluate(`(()=>{const x=[...document.querySelectorAll('button')].find(x=>x.getClientRects().length&&x.getAttribute('aria-label')?.startsWith('Open this strategy — '));if(!x||x.disabled)return false;x.click();return true})()`));
  await b.wait(`!![...document.querySelectorAll('[role="dialog"]')].find(x=>x.getClientRects().length&&x.textContent.toLowerCase().includes('long gate'))`);
  await shot('21-browser-legacy-wizard');
  await b.page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await b.page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.ok(await b.evaluate(`(()=>{const x=[...document.querySelectorAll('button')].filter(x=>x.getClientRects().length&&x.getAttribute('aria-label')?.startsWith('Open this strategy — ')).at(-1);if(!x||x.disabled)return false;x.click();return true})()`));
  await b.wait(`!![...document.querySelectorAll('[role="dialog"]')].find(x=>x.getClientRects().length&&x.textContent.toLowerCase().includes('long binance'))`);
  await shot('21-browser-legacy-four-leg-wizard');
  await b.page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await b.page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await click('Funding Spreads'); await action('stale'); await reload();
  await b.wait(`document.body.innerText.includes('STALE')||document.body.innerText.includes('current UTC hour')`);
  await shot('21-browser-stale');
  s = await status(); assert.equal(s.deals.length, 1); assert.equal(posts(s).length, 2); assert.equal(s.admission.open, false);
  evidence.server = s; evidence.result = 'passed';
  console.log(JSON.stringify({ result: evidence.result, steps: evidence.steps.length, deals: s.deals.length, acceptancePosts: posts(s).length, run: root }));
} catch (error) {
  evidence.result = 'failed'; evidence.error = String(error);
  try { evidence.server = await status(); } catch {}
  try {
    evidence.failureText = await text();
    evidence.failureControls = await b.evaluate(`({buttons:[...document.querySelectorAll('button')].filter(x=>x.getClientRects().length).map(x=>({text:x.innerText,disabled:x.disabled})),inputs:[...document.querySelectorAll('input')].filter(x=>x.getClientRects().length).map(x=>({label:x.getAttribute('aria-label'),value:x.value,checked:x.checked,disabled:x.disabled}))})`);
    await b.screenshot(root + 'failure.png');
  } catch {}
  throw error;
} finally {
  writeFileSync(root + 'evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync(base + '21-browser-evidence.json', JSON.stringify({ run: root, result: evidence.result, error: evidence.error ?? null }, null, 2) + '\n');
  await b?.close();
  try { process.kill(-fixture.pid, 'SIGTERM'); } catch {}
  await pause(300);
}
