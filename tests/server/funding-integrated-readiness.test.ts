/** Cross-ticket behavior through HTTP, the normal engine tick, and venue truth. */
import { afterEach, expect, it, vi } from 'vitest';
import { tickPair } from '../../src/engine/loop';
import { integratedFundingWorld } from '../helpers/funding-integrated-fixture';
import { confirm, LONG_SYMBOL, SHORT_SYMBOL, request } from '../helpers/funding-intent-fixture';
import { HOST, mockGateGet } from './helpers/gate-nock';

let w: Awaited<ReturnType<typeof integratedFundingWorld>>;
afterEach(async () => { await w?.app.close(); });

const tick = async (id: string, count = 1) => {
  for (let i = 0; i < count; i++) { await tickPair(w, id); w.clock.advance(1000); }
};
const receipt = (id: string) => w.app.inject({ method: 'GET', url: `/api/funding/intents/${id}`, headers: HOST });

it('carries an A-page candidate through one accepted deal, admission closure, partial fill and its exact slice', async () => {
  w = await integratedFundingWorld();
  const sourceCalls = [...w.sourceCalls];
  const board = (await w.get()).body.data;
  expect(board).toMatchObject({ rankedCount: 2, admission: { open: false } });
  const row = board.rows[0];
  const draft = request({ snapshotId: board.snapshotId, quantity: '0.15', short: row.short, long: row.long });
  const closed = await w.post('/api/funding/preview', draft);
  expect(closed.body.data.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'admission-closed' })]));
  expect((await w.post('/api/admission', { open: true })).status).toBe(200);
  const preview = await w.post('/api/funding/preview', draft);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const body = confirm(preview, 'integrated-001');
  const [first, replay] = await Promise.all([w.post('/api/funding/intents', body), w.post('/api/funding/intents', body)]);
  expect([first.status, replay.status].sort()).toEqual([200, 202]);
  expect(first.body.data.dealId).toBe(replay.body.data.dealId);
  const dealId = first.body.data.dealId;
  const sliceId = first.body.data.sliceId;
  expect(w.venue.createCalls).toEqual([]);
  expect(w.venue.leverageCalls).toEqual([]);
  await w.post('/api/admission', { open: false });
  await tick(dealId, 3);
  const maker = w.venue.liveOrder(LONG_SYMBOL)!;
  expect(maker).toBeDefined();
  w.venue.fill(maker.clientText, '0.05');
  await tick(dealId, 2);
  expect((await receipt('integrated-001')).json().data.deal).toMatchObject({ aFilled: '0.05', bFilled: '0.05', aUnfilled: '0.1' });
  expect((await w.post(`/api/deals/${dealId}/stop`, {})).status).toBe(200);
  await tick(dealId, 4);
  expect((await receipt('integrated-001')).json().data.deal).toMatchObject({ mode: 'DONE', aFilled: '0.05', bFilled: '0.05', aUnfilled: '0.1' });
  expect(w.venue.createCalls).toHaveLength(2);
  mockGateGet('/positions', { body: [{ symbol: LONG_SYMBOL, position_qty: '0.05' }, { symbol: SHORT_SYMBOL, position_qty: '-0.05' }] });
  const slices = (await w.app.inject({ method: 'GET', url: '/api/slices', headers: HOST })).json().data;
  expect(slices.slices).toEqual([expect.objectContaining({ id: sliceId })]);
  expect(slices.contracts).toEqual(expect.arrayContaining([
    expect.objectContaining({ contract: LONG_SYMBOL, status: 'reconciled', attributed: '0.05', unattributed: '0' }),
    expect.objectContaining({ contract: SHORT_SYMBOL, status: 'reconciled', attributed: '-0.05', unattributed: '0' }),
  ]));
  expect(w.sourceCalls).toEqual(sourceCalls);
});

it('expires a board preview during its current-evidence reread and keeps the old cache timestamp across UTC rollover', async () => {
  w = await integratedFundingWorld();
  await w.post('/api/admission', { open: true });
  const board = (await w.get()).body.data;
  const row = board.rows[0];
  const preview = await w.post('/api/funding/preview', request({ quantity: '0.15', snapshotId: board.snapshotId, short: row.short, long: row.long }));
  expect(preview.body.data.blockers).toEqual([]);
  w.clock.advance(5_000);
  w.state.readMs = 6_000;
  const refused = await w.post('/api/funding/intents', confirm(preview, 'expired-integrated'));
  expect(refused.status).toBe(409);
  expect(refused.body.error.label).toBe('preview-expired');
  expect(refused.body.preview.previewId).not.toBe(preview.body.data.previewId);
  expect(w.venue.createCalls).toEqual([]);
  expect(w.venue.leverageCalls).toEqual([]);
  const missing = await w.app.inject({ method: 'GET', url: `/api/funding/intents/expired-integrated?previewId=${preview.body.data.previewId}`, headers: HOST });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().lateAcceptance.possible).toBe(false);
  w.state.readMs = 0;
  w.clock.advance(3_600_000);
  const stale = (await w.get()).body.data;
  expect(stale.history).toMatchObject({ cutoffBehind: true, publishedAt: board.history.publishedAt });
  expect(stale.rankedCount).toBe(0);
  expect(stale.rows.every((r: { rank: number | null }) => r.rank === null)).toBe(true);
});

it('keeps a lost-wire maker quarantined through closure and unconfirmed Stop, then reconciles its actual partial without resubmitting', async () => {
  w = await integratedFundingWorld();
  await w.post('/api/admission', { open: true });
  const board = (await w.get()).body.data;
  const row = board.rows[0];
  const preview = await w.post('/api/funding/preview', request({ quantity: '0.15', snapshotId: board.snapshotId, short: row.short, long: row.long }));
  const body = confirm(preview, 'unknown-integrated');
  const accepted = await w.post('/api/funding/intents', body);
  expect(accepted.status).toBe(202);
  const id = accepted.body.data.dealId;
  const deadline = accepted.body.data.deal.deadlineAt;
  w.venue.nextCreate.push('unknown-delivered');
  await tick(id, 3); // Resolve the two leverage checks, then submit the maker.
  const maker = w.venue.liveOrder(LONG_SYMBOL)!;
  expect((await receipt('unknown-integrated')).json().data.deal.orders).toEqual(expect.arrayContaining([expect.objectContaining({ leg: 'A', state: 'PENDING' })]));
  w.venue.setRawStatus(maker.clientText, 'PARTIALLY_MYSTERIOUS');
  await w.post('/api/admission', { open: false });
  await tick(id, 2);
  w.venue.cancelsFail = true;
  expect((await w.post(`/api/deals/${id}/stop`, {})).status).toBe(200);
  await tick(id, 2);
  const quarantined = (await receipt('unknown-integrated')).json().data;
  expect(quarantined.deal.orders).toEqual(expect.arrayContaining([expect.objectContaining({ quarantinedStatus: 'PARTIALLY_MYSTERIOUS' })]));
  expect(w.venue.createCalls).toHaveLength(1);
  w.venue.cancelsFail = false;
  w.venue.setRawStatus(maker.clientText, 'NEW');
  w.venue.fill(maker.clientText, '0.05');
  await tick(id, 6);
  const final = (await receipt('unknown-integrated')).json().data;
  expect(final.deal).toMatchObject({ mode: 'DONE', deadlineAt: deadline, aFilled: '0.05', bFilled: '0.05', aUnfilled: '0.1' });
  expect((await w.post('/api/funding/intents', body)).status).toBe(200);
  expect(w.venue.createCalls).toHaveLength(2);
});

it('finishes only its original authorized expiry conversion after admission closes, with one wire mutation per tick', async () => {
  w = await integratedFundingWorld();
  await w.post('/api/admission', { open: true });
  const board = (await w.get()).body.data;
  const row = board.rows[0];
  const preview = await w.post('/api/funding/preview', request({ quantity: '0.15', snapshotId: board.snapshotId, short: row.short, long: row.long }));
  const accepted = await w.post('/api/funding/intents', confirm(preview, 'conversion-integrated'));
  expect(accepted.status).toBe(202);
  const id = accepted.body.data.dealId;
  await tick(id, 3);
  w.venue.fill(w.venue.liveOrder(LONG_SYMBOL)!.clientText, '0.05');
  await w.post('/api/admission', { open: false });
  w.clock.advance(300_000);
  const creates = vi.spyOn(w.venue, 'create');
  const cancels = vi.spyOn(w.venue, 'cancel');
  for (let i = 0; i < 16; i++) {
    const before = creates.mock.calls.length + cancels.mock.calls.length;
    await tick(id);
    expect(creates.mock.calls.length + cancels.mock.calls.length - before).toBeLessThanOrEqual(1);
    if ((await receipt('conversion-integrated')).json().data.deal.mode === 'DONE') break;
  }
  const final = (await receipt('conversion-integrated')).json().data;
  expect(final.content.onExpiry).toBe('convert-to-taker');
  expect(final.deal).toMatchObject({ mode: 'DONE', deadlineAt: accepted.body.data.deal.deadlineAt, aFilled: '0.15', bFilled: '0.15', aUnfilled: '0' });
  expect(w.venue.createCalls).toHaveLength(4);
  expect(new Set(w.venue.createCalls).size).toBe(4);
});
