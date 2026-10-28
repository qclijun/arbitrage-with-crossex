/**
 * POST /api/funding/intents (ticket 12): acceptance re-reads every piece of
 * evidence, must find exactly what the user confirmed, and lands within 10 s
 * of both evidence rounds — else a new preview. It writes intent, slice and
 * deal together and wakes the engine, which alone sets leverage (one leg per
 * tick) and then places the maker. A refused acceptance mutates nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { confirm, fundingWorld, LONG_SYMBOL, SHORT_SYMBOL, type FundingWorld } from '../helpers/funding-intent-fixture';

let w: FundingWorld;
afterEach(async () => {
  await w?.app.close();
});

const nothingHappened = (world: FundingWorld) => {
  expect(world.store.listPairs()).toEqual([]);
  expect(world.store.slices.get('fs-intent-001')).toBeNull();
  expect(world.venue.leverageCalls).toEqual([]);
  expect(world.venue.createCalls).toEqual([]);
};

describe('funding acceptance', () => {
  it('writes the intent, slice and deal at once; the engine then sets leverage and places', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    const res = await w.accept(confirm(preview));
    expect(res.status).toBe(202);
    const { data } = res.body;
    expect(data).toMatchObject({ intentId: 'intent-001', dealId: 'fi-intent-001', sliceId: 'fs-intent-001', content: preview.body.data.content });
    const pair = w.store.getPair('fi-intent-001')!;
    expect(pair).toMatchObject({
      purpose: 'funding-two-leg', mode: 'OPENING', targetQty: '0.15', limitPrice: '2499.9', pricePolicy: 'fixed', clipBandBp: null,
      a: { contract: LONG_SYMBOL, side: 'BUY' }, b: { contract: SHORT_SYMBOL, side: 'SELL' },
      leverage: [{ leg: 'A', target: '5', state: 'pending' }, { leg: 'B', target: '3', state: 'pending' }],
    });
    expect(pair.deadlineAt).toBe(data.acceptedAt + 300_000);
    expect(w.store.slices.get('fs-intent-001')).toMatchObject({ kind: 'funding-two-leg' });
    expect(w.venue.leverageCalls).toEqual([]); // the route never touches the venue

    w.venue.leverage.set(LONG_SYMBOL, '10');
    w.venue.leverage.set(SHORT_SYMBOL, '3');
    await w.tick('fi-intent-001');
    expect(w.venue.leverageCalls).toEqual([{ contract: LONG_SYMBOL, leverage: '5' }]);
    await w.tick('fi-intent-001', 2);
    expect(w.venue.leverageCalls).toHaveLength(1); // B already at 3
    expect(w.venue.createCalls).toHaveLength(1);
  });

  it('answers a retry with the original deal and never moves its deadline; a different payload conflicts', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    const first = await w.accept(confirm(preview));
    const deadline = w.store.getPair('fi-intent-001')!.deadlineAt;
    w.clock.advance(60_000); // far past the preview: a retry is a query, not a new trade
    const retry = await w.accept(confirm(preview));
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ dealId: first.body.data.dealId, duplicate: true, deal: { deadlineAt: deadline } });
    const other = await w.accept(confirm(preview, 'intent-001', { contentHash: 'f'.repeat(64) }));
    expect(other.status).toBe(409);
    expect(other.body.error.label).toBe('intent-conflict');
    expect(w.store.listPairs()).toHaveLength(1);
  });

  it('expires at exactly 10 s after the preview read began, answering with a new preview', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    w.clock.advance(10_000);
    const res = await w.accept(confirm(preview));
    expect(res.status).toBe(409);
    expect(res.body.error.label).toBe('preview-expired');
    expect(res.body.preview.previewId).not.toBe(preview.body.data.previewId);
    nothingHappened(w);

    const again = await w.preview();
    w.clock.advance(9_999);
    expect((await w.accept(confirm(again))).status).toBe(202);
  });

  it('expires when the acceptance re-read itself runs past the preview', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    w.state.readMs = 6_000;
    w.clock.advance(5_000);
    const res = await w.accept(confirm(preview));
    expect(res.body.error.label).toBe('preview-expired');
    nothingHappened(w);
  });

  it('refuses a cutoff that moved across the UTC hour within the 10 s', async () => {
    w = fundingWorld({ at: Date.UTC(2026, 9, 29, 10, 59, 55) });
    const preview = await w.preview();
    expect(preview.body.data.blockers).toEqual([]);
    w.clock.advance(6_000);
    const res = await w.accept(confirm(preview));
    expect(res.body.error.label).toBe('admission-refused');
    expect(res.body.preview.blockers.map((b: { code: string }) => b.code)).toContain('history-cutoff-behind');
    nothingHappened(w);
  });

  it('returns a new preview, without accepting, when what was confirmed changed', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    w.state.fees[1].futureTakerFee = '0.0006';
    const res = await w.accept(confirm(preview));
    expect(res.body.error.label).toBe('preview-changed');
    expect(res.body.preview.content.fees.short.taker).toBe('0.0006');
    nothingHappened(w);
  });

  it('refuses when the fresh evidence now blocks, with no venue mutation', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    w.state.openOrders = [{ symbol: LONG_SYMBOL }];
    const res = await w.accept(confirm(preview));
    expect(res.body.error.label).toBe('admission-refused');
    nothingHappened(w);
  });

  it.each([
    [{ authorizeConversion: false }, 'conversion-unauthorized'],
    [{ acknowledgeRisks: false }, 'risks-unacknowledged'],
    [{ contentHash: '0'.repeat(64) }, 'preview-mismatch'],
    [{ previewId: 'never-minted' }, 'preview-unknown'],
  ])('refuses %j before re-reading anything', async (over, label) => {
    w = fundingWorld();
    const preview = await w.preview();
    const reads = w.reads.calls;
    const res = await w.accept(confirm(preview, 'intent-001', over));
    expect(res.status).toBe(409);
    expect(res.body.error.label).toBe(label);
    expect(w.reads.calls).toBe(reads);
    nothingHappened(w);
  });
});
