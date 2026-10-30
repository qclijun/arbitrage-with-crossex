/** Ticket 21's invented ETH world: real market/cache/admission/engine, fake IO. */
import { boardWorld } from './funding-board-fixture';
import { flat, historyLeg, live, publish } from './funding-ranking-fixture';
import { LONG_SYMBOL, SHORT_SYMBOL } from './funding-intent-fixture';
import type { Store } from '../../src/engine/db';

export async function integratedFundingWorld(opts: { store?: Store } = {}) {
  const hl = historyLeg('HYPERLIQUID', 'ETH', flat('0.0001'));
  hl.source.api = 'info:fundingHistory';
  const w = await boardWorld({
    ...opts,
    listings: [
      { ...live('OKX', 'ETH-USDT-SWAP', 'ETH'), symbol: SHORT_SYMBOL },
      { ...live('HYPERLIQUID', 'ETH', 'ETH'), symbol: LONG_SYMBOL },
    ],
    history: publish([historyLeg('OKX', 'ETH-USDT-SWAP', flat('0.0003')), hl]),
  });
  w.venue.leverage.set(LONG_SYMBOL, '10');
  w.venue.leverage.set(SHORT_SYMBOL, '3');
  for (const [venue, contractId, rateText] of [['OKX', 'ETH-USDT-SWAP', '0.0003'], ['HYPERLIQUID', 'ETH', '0.0001']]) {
    w.quotes[venue] = [{ base: 'ETH', contractId, rateText, rate: Number(rateText), intervalHours: 8,
      markPrice: 2500, nextFundingTime: null }];
  }
  await w.market.runOnce();
  return w;
}
