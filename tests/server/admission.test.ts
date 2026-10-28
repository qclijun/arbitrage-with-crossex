/**
 * GET/POST /api/admission (ticket 19). Closing the switch is not a Stop and
 * not stop.sh: an accepted deal keeps converging exactly as confirmed, the
 * loop keeps running, and the switch itself makes no venue call.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/engine/db';
import { tickPair } from '../../src/engine/loop';
import { A_CONTRACT, FakeVenue, mkWorld, VirtualClock } from '../unit/engine-sim';
import { HOST, makeTestApp } from './helpers/gate-nock';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

const get = () => app.inject({ method: 'GET', url: '/api/admission', headers: HOST });
const set = (payload: unknown) => app.inject({ method: 'POST', url: '/api/admission', headers: HOST, payload: payload as object });

describe('/api/admission', () => {
  it('reads closed until explicitly enabled, then moves the generation on every change', async () => {
    const store = new Store(':memory:', { programVersion: '1.8.0' });
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock: new VirtualClock() } });
    expect((await get()).json().data).toMatchObject({ open: false, generation: 0, reason: 'never-enabled' });
    expect((await set({ open: true })).json().data).toMatchObject({ open: true, generation: 1, enabledVersion: '1.8.0' });
    expect((await set({ open: false })).json().data).toMatchObject({ open: false, generation: 2, reason: 'closed' });
    expect((await get()).json().data.generation).toBe(2);
  });

  it.each([{}, { open: 'yes' }, { open: 1 }])('refuses a body that does not say open true or false: %j', async (body) => {
    const store = new Store(':memory:', { programVersion: '1.8.0' });
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock: new VirtualClock() } });
    expect((await set(body)).statusCode).toBe(400);
    expect(store.admission.read().generation).toBe(0);
  });

  it('refuses to enable a program that cannot name its version, and says why', async () => {
    const store = new Store(':memory:');
    app = makeTestApp({ engine: { store, venue: new FakeVenue(), clock: new VirtualClock() } });
    const res = await set({ open: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/version/);
    expect((await get()).json().data).toMatchObject({ open: false, reason: 'version-unknown' });
  });

  it('closing leaves an accepted maker deal converging as confirmed, with no venue call of its own', async () => {
    const w = mkWorld({});
    app = makeTestApp({ engine: { store: w.store, venue: w.venue, clock: w.clock } });
    await tickPair(w, w.pairId); // maker placed
    const maker = w.venue.liveOrder(A_CONTRACT)!;
    const calls = w.venue.createCalls.length;
    const before = w.store.getPair(w.pairId)!;

    expect((await set({ open: false })).statusCode).toBe(200);
    expect(w.venue.createCalls.length).toBe(calls);
    expect(w.venue.liveOrder(A_CONTRACT)!.clientText).toBe(maker.clientText);
    expect(w.store.getPair(w.pairId)).toEqual(before);

    // The loop keeps converging the deal it accepted: fill → hedge → DONE.
    w.venue.fill(maker.clientText, before.targetQty);
    for (let i = 0; i < 6; i++) {
      await tickPair(w, w.pairId);
      w.clock.advance(1000);
    }
    expect(w.store.getPair(w.pairId)!.mode).toBe('DONE');
  });
});
