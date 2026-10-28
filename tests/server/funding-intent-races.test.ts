/**
 * Funding intents under races and over time (ticket 12): concurrent
 * acceptances of one intent id create at most one deal; a consumed or
 * pre-reopen preview cannot be revived; the receipt stays queryable through
 * the deal's terminal state with its original deadline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { confirm, fundingWorld, LONG_SYMBOL, SHORT_SYMBOL, type FundingWorld } from '../helpers/funding-intent-fixture';

let w: FundingWorld;
afterEach(async () => {
  await w?.app.close();
});

describe('funding intent races', () => {
  it('two simultaneous acceptances of the same intent create one deal and both see it', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    const [a, b] = await Promise.all([w.accept(confirm(preview)), w.accept(confirm(preview))]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body.data.dealId).toBe(b.body.data.dealId);
    expect(w.store.listPairs()).toHaveLength(1);
  });

  it('the same intent id with different content, concurrently, is one deal and one conflict', async () => {
    w = fundingWorld();
    const one = await w.preview();
    const two = await w.preview({ holdDays: '60' });
    const [a, b] = await Promise.all([w.accept(confirm(one)), w.accept(confirm(two))]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.label).toBe('intent-conflict');
    expect(w.store.listPairs()).toHaveLength(1);
  });

  it('a preview accepted once cannot be accepted again under another intent', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    expect((await w.accept(confirm(preview))).status).toBe(202);
    const late = await w.accept(confirm(preview, 'intent-002'));
    expect(late.status).toBe(409);
    expect(late.body.error.label).toBe('preview-consumed');
    expect(w.store.listPairs()).toHaveLength(1);
  });

  it('closing and reopening admission does not revive a preview minted before', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    w.store.admission.disable(w.clock.now());
    w.store.admission.enable(w.clock.now());
    const res = await w.accept(confirm(preview));
    expect(res.status).toBe(409);
    expect(res.body.error.label).toBe('admission-closed');
    expect(w.store.listPairs()).toEqual([]);
    expect(w.venue.leverageCalls).toEqual([]);
  });

  it('keeps the receipt through the terminal state, with the deadline never extended', async () => {
    w = fundingWorld();
    expect((await w.receipt('intent-001')).status).toBe(404);
    const accepted = await w.accept(confirm(await w.preview()));
    const deadline = accepted.body.data.deal.deadlineAt;
    w.venue.leverage.set(LONG_SYMBOL, '5');
    w.venue.leverage.set(SHORT_SYMBOL, '3');
    await w.tick('fi-intent-001', 3); // both leverages already right: maker placed
    const maker = w.venue.liveOrder(LONG_SYMBOL)!;
    w.venue.fill(maker.clientText, '0.15');
    await w.tick('fi-intent-001', 6);
    const done = await w.receipt('intent-001');
    expect(done.status).toBe(200);
    expect(done.body.data.deal).toMatchObject({ mode: 'DONE', aFilled: '0.15', bFilled: '0.15', deadlineAt: deadline });
    expect(done.body.data.content).toEqual(accepted.body.data.content);
  });

  it('a deal whose leverage is refused ends with nothing placed, and the receipt says why', async () => {
    w = fundingWorld();
    await w.accept(confirm(await w.preview()));
    w.venue.leverage.set(LONG_SYMBOL, '10');
    w.venue.nextLeverage.push('reject:LEVERAGE_TOO_HIGH');
    await w.tick('fi-intent-001', 3);
    expect(w.venue.createCalls).toEqual([]);
    const receipt = await w.receipt('intent-001');
    expect(receipt.body.data.deal.mode).toBe('DONE');
    expect(receipt.body.data.deal.report.reason).toMatch(/leverage not confirmed.*LEVERAGE_TOO_HIGH/);
  });
});
