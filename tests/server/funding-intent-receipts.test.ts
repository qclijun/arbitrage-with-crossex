/**
 * What a funding receipt tells the page (ticket 14): each leg's real fills
 * apart from what is merely reserved, the unacquired remainder, and every
 * order as the ledger records it, unclassifiable venue statuses verbatim. The
 * ledger's intents for one candidate are listed by exact id, finished ones
 * included, for a page with no local record of them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { candidateIdOf } from '../../src/server/funding/request';
import { confirm, fundingWorld, LONG_SYMBOL, request, SHORT_SYMBOL, type FundingWorld } from '../helpers/funding-intent-fixture';
import { HOST } from './helpers/gate-nock';

let w: FundingWorld;
afterEach(async () => {
  await w?.app.close();
});

const DEAL = 'fi-intent-001';

async function makerPlaced() {
  await w.accept(confirm(await w.preview()));
  w.venue.leverage.set(LONG_SYMBOL, '5');
  w.venue.leverage.set(SHORT_SYMBOL, '3');
  await w.tick(DEAL, 3);
  return w.venue.liveOrder(LONG_SYMBOL)!;
}

describe('funding receipts', () => {
  it('a part-filled maker whose hedge is rejected shows the real fills, not the reservation', async () => {
    w = fundingWorld();
    const maker = await makerPlaced();
    w.venue.fill(maker.clientText, '0.05');
    w.venue.nextCreate.push('reject:BALANCE_NOT_ENOUGH');
    await w.tick(DEAL, 2);
    const { deal } = (await w.receipt('intent-001')).body.data;
    expect(deal).toMatchObject({ targetQty: '0.15', aFilled: '0.05', bFilled: '0', unhedged: '0.05', aUnfilled: '0.1', filledGap: '0.05' });
    const hedge = deal.orders.find((o: any) => o.leg === 'B');
    expect(hedge).toMatchObject({ kind: 'taker', state: 'DEAD', cumQty: '0' });
    expect(hedge.closeReason).toMatch(/BALANCE_NOT_ENOUGH/);
  });

  it('an order on a status the engine cannot classify is shown verbatim as quarantined', async () => {
    w = fundingWorld();
    const maker = await makerPlaced();
    w.venue.setRawStatus(maker.clientText, 'PARTIALLY_MYSTERIOUS');
    await w.tick(DEAL, 2);
    const { deal } = (await w.receipt('intent-001')).body.data;
    expect(deal.orders.find((o: any) => o.leg === 'A')).toMatchObject({ quarantinedStatus: 'PARTIALLY_MYSTERIOUS' });
  });

  it('lists a candidate\'s accepted intents by id, newest first, finished ones included', async () => {
    w = fundingWorld();
    const maker = await makerPlaced();
    w.venue.fill(maker.clientText, '0.15');
    await w.tick(DEAL, 6);
    expect(w.store.getPair(DEAL)!.mode).toBe('DONE');
    w.state.positions = [{ symbol: LONG_SYMBOL, positionQty: '0.15' }, { symbol: SHORT_SYMBOL, positionQty: '-0.15' }];
    expect((await w.accept(confirm(await w.preview(), 'intent-002'))).status).toBe(202);

    const url = (id: string) => `/api/funding/intents?candidateId=${encodeURIComponent(id)}`;
    const res = await w.app.inject({ method: 'GET', url: url(candidateIdOf(request() as never)), headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((r: any) => [r.intentId, r.deal.mode])).toEqual([['intent-002', 'OPENING'], ['intent-001', 'DONE']]);

    const other = await w.app.inject({ method: 'GET', url: url('["BTC","OKX","x","HYPERLIQUID","y"]'), headers: HOST });
    expect(other.json().data).toEqual([]);
  });
});
