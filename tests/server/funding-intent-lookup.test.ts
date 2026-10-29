/**
 * Looking up a submitted funding intent (ticket 14). A lost acceptance answer
 * is resolved by asking for the original id: found is the receipt; not found
 * proves nothing on its own, unless the server can also prove the preview it
 * carried can never be accepted any more (expired by the server's clock,
 * consumed, unacceptable, or unknown to this process).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { confirm, fundingWorld, type FundingWorld } from '../helpers/funding-intent-fixture';
import { HOST } from './helpers/gate-nock';

let w: FundingWorld;
afterEach(async () => {
  await w?.app.close();
});

const lookup = async (id: string, previewId?: string) => {
  const url = `/api/funding/intents/${id}${previewId ? `?previewId=${encodeURIComponent(previewId)}` : ''}`;
  const res = await w.app.inject({ method: 'GET', url, headers: HOST });
  return { status: res.statusCode, body: res.json() };
};

describe('funding intent lookup', () => {
  it('a not-found while the preview can still be accepted is not settled; after its expiry it is', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    const { previewId, expiresAt } = preview.body.data;
    const pending = await lookup('intent-001', previewId);
    expect(pending.status).toBe(404);
    expect(pending.body.error.label).toBe('intent-unknown');
    expect(pending.body.lateAcceptance).toEqual({ possible: true, until: expiresAt });

    w.clock.t = expiresAt;
    const settled = await lookup('intent-001', previewId);
    expect(settled.status).toBe(404);
    expect(settled.body.lateAcceptance).toEqual({ possible: false, reason: 'preview-expired' });
    // The late request itself is then refused, as the proof promised.
    expect((await w.accept(confirm(preview))).status).toBe(409);
    expect(w.store.listPairs()).toEqual([]);
  });

  it('without the preview id a not-found proves nothing', async () => {
    w = fundingWorld();
    const res = await lookup('intent-001');
    expect(res.status).toBe(404);
    expect(res.body.lateAcceptance).toBeUndefined();
  });

  it('a preview this process does not know (restart, forgotten) can never be accepted', async () => {
    w = fundingWorld();
    const res = await lookup('intent-001', 'no-such-preview');
    expect(res.body.lateAcceptance).toEqual({ possible: false, reason: 'preview-unknown' });
  });

  it('a preview consumed by another intent can never be accepted under this one', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    expect((await w.accept(confirm(preview, 'intent-other'))).status).toBe(202);
    const res = await lookup('intent-001', preview.body.data.previewId);
    expect(res.body.lateAcceptance).toEqual({ possible: false, reason: 'preview-consumed' });
  });

  it('the late request accepted after a not-found is then found, with its receipt', async () => {
    w = fundingWorld();
    const preview = await w.preview();
    expect((await lookup('intent-001', preview.body.data.previewId)).status).toBe(404);
    expect((await w.accept(confirm(preview))).status).toBe(202);
    const found = await lookup('intent-001', preview.body.data.previewId);
    expect(found.status).toBe(200);
    expect(found.body.data).toMatchObject({ intentId: 'intent-001', dealId: 'fi-intent-001' });
  });
});
