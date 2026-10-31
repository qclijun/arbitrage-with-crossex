import { afterEach, expect, it } from 'vitest';
import { boardWorld, type BoardWorld } from '../helpers/funding-board-fixture';
import { flat, historyLeg, publish } from '../helpers/funding-ranking-fixture';

let world: BoardWorld | undefined;
afterEach(async () => { await world?.app.close(); });
const isForward = (r: any) => r.short.venue === 'BINANCE' && r.short.contractId === 'BTCUSDT' && r.long.venue === 'BYBIT';

const histories = () => ['BINANCE', 'BYBIT'].map((venue) => {
  const leg = historyLeg(venue, 'BTCUSDT', flat(venue === 'BINANCE' ? '0.0002' : '0.0001'));
  leg.rules = [];
  leg.events = leg.events.map((event) => ({ ...event, intervalHours: null }));
  return leg;
});

it('shows exact observed pair totals without scoring unverified schedules or enabling admission', async () => {
  world = await boardWorld({ history: publish(histories()) });
  const before = [...world.sourceCalls];
  const { body } = await world.get('?underlying=BTC&days=7');
  const forward = body.data.rows.find(isForward);
  const reverse = body.data.rows.find((r: any) => r.short.venue === 'BYBIT' && r.long.venue === 'BINANCE' && r.long.contractId === 'BTCUSDT');
  expect(forward).toMatchObject({ rank: null });
  expect(forward.windows[0]).toMatchObject({ eligible: false, coverage: 'unknown', netTotal: null, netAnnualized: null,
    observed: { netTotal: '0.0021', netAnnualized: '0.1095', fresh: true },
    legs: { short: { observed: { total: '0.0042', events: 21 } }, long: { observed: { total: '0.0021', events: 21 } } } });
  expect(reverse.windows[0].observed).toMatchObject({ netTotal: '-0.0021', netAnnualized: '-0.1095' });
  expect(body.data.rankedCount).toBe(0);
  expect(body.data.admission.open).toBe(false);
  expect(world.sourceCalls).toEqual(before);
  expect((await world.get('?positive=1')).body.data.rows).toEqual([]);
});

it.each(['pagination', 'conflict', 'source', 'missing-leg'] as const)('withholds observed spreads for %s failures', async (failure) => {
  const legs = histories();
  if (failure === 'pagination') legs[1]!.pages.complete = false;
  if (failure === 'conflict') legs[1]!.events.push({ ...legs[1]!.events.at(-1)!, rate: '0.123' });
  if (failure === 'source') legs[1]!.source.status = 'unknown';
  if (failure === 'missing-leg') legs.pop();
  world = await boardWorld({ history: publish(legs) });
  const { body } = await world.get('?days=7');
  const row = body.data.rows.find(isForward);
  expect(row.windows[0].observed).toBeNull();
});

it('keeps stale observations at their original cutoff with an explicit freshness flag', async () => {
  world = await boardWorld({ history: publish(histories()) });
  world.clock.t += 20 * 60_000;
  const { body } = await world.get('?days=7');
  const row = body.data.rows.find(isForward);
  expect(row.windows[0].observed).toMatchObject({ netAnnualized: '0.1095', fresh: false });
  expect(row.rank).toBeNull();
});

it('preserves tiny observed spreads instead of rounding a known nonzero total to zero', async () => {
  const legs = histories();
  for (const leg of legs) for (const event of leg.events) event.rate = leg.venue === 'BINANCE' ? '0.000000000000000000002' : '0.000000000000000000001';
  world = await boardWorld({ history: publish(legs) });
  const { body } = await world.get('?days=7');
  expect(body.data.rows.find(isForward).windows[0].observed).toMatchObject({
    netTotal: '0.000000000000000000021', netAnnualized: '0.000000000000000001095',
  });
});
