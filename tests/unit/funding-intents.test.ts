/** The accepted funding-intent record (ticket 12): durable, one per intent id,
 * one per preview, and found again after a restart. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { deal, LONG_C, SHORT_C } from '../helpers/slice-fixture';

const row = (over: Partial<Parameters<Store['fundingIntents']['insert']>[0]> = {}) => ({
  id: 'intent-1', fingerprint: 'fp-1', previewId: 'preview-1', candidateId: 'cand', dealId: 'fi-intent-1',
  sliceId: 'fs-intent-1', content: { quantity: '0.1' }, acceptedAt: 1_000, ...over,
});

describe('funding intents', () => {
  it('round-trips a record and survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intents-'));
    const file = path.join(dir, 'deals.sqlite');
    const store = new Store(file);
    deal(store, 'fi-intent-1', { contract: SHORT_C, side: 'SELL' }, { contract: LONG_C, side: 'BUY' }, '0.1');
    store.fundingIntents.insert(row());
    expect(store.fundingIntents.get('intent-1')).toEqual(row());
    store.close();
    const reopened = new Store(file);
    expect(reopened.fundingIntents.get('intent-1')).toEqual(row());
    expect(reopened.fundingIntents.byPreview('preview-1')?.id).toBe('intent-1');
    expect(reopened.fundingIntents.get('missing')).toBeNull();
    reopened.close();
  });

  it('holds one record per intent id and per preview', () => {
    const store = new Store(':memory:');
    deal(store, 'fi-intent-1', { contract: SHORT_C, side: 'SELL' }, { contract: LONG_C, side: 'BUY' }, '0.1');
    deal(store, 'fi-intent-2', { contract: SHORT_C, side: 'SELL' }, { contract: LONG_C, side: 'BUY' }, '0.1');
    store.fundingIntents.insert(row());
    expect(() => store.fundingIntents.insert(row({ fingerprint: 'fp-2', previewId: 'preview-2', dealId: 'fi-intent-2' }))).toThrow();
    expect(() => store.fundingIntents.insert(row({ id: 'intent-2', dealId: 'fi-intent-2' }))).toThrow();
  });
});
