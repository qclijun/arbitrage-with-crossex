import { describe, expect, it, vi } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { fetchVenueBook } from '../../src/core/estimate/books';
import { gateVenue } from '../../src/engine/venueGate';

vi.mock('../../src/core/estimate/books', () => ({ fetchVenueBook: vi.fn() }));

const book = (bid: string | number, ask: string | number) =>
  ({ bids: [[bid, '1']], asks: [[ask, '1']] }) as unknown as Awaited<ReturnType<typeof fetchVenueBook>>;

describe('gateVenue.touch', () => {
  // The touch price rests post-only, so it snaps AWAY from crossing. One gap
  // behind the touch: BUY 2·100.017 − 100.018 = 100.016 → 100.01 (nearest
  // 100.02); SELL 2·100.011 − 100.010 = 100.012 → 100.02 (nearest 100.01).
  it('snaps the behind-touch price directionally, not to the nearest tick', async () => {
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(book('100.017', '100.018'));
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(book('100.010', '100.011'));
    const venue = gateVenue(() => ({}) as Clients);

    expect(await venue.touch('BINANCE_FUTURE_ETH_USDT', 'BUY', '0.01')).toBe('100.01');
    expect(await venue.touch('BINANCE_FUTURE_ETH_USDT', 'SELL', '0.01')).toBe('100.02');
  });
});

describe('gateVenue.bestQuote', () => {
  const oneSided = (side: 'bids' | 'asks', px: string) =>
    (side === 'bids' ? { bids: [[px, '1']], asks: [] } : { bids: [], asks: [[px, '1']] }) as unknown as Awaited<
      ReturnType<typeof fetchVenueBook>
    >;

  it('returns the BARE best bid/ask (no spread offset) — distinct from touch', async () => {
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(book('100.00', '100.03'));
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(book('100.00', '100.03'));
    const venue = gateVenue(() => ({}) as Clients);

    expect(await venue.bestQuote('BINANCE_FUTURE_ETH_USDT', 'BUY', '0.01')).toBe('100');
    expect(await venue.bestQuote('BINANCE_FUTURE_ETH_USDT', 'SELL', '0.01')).toBe('100.03');
  });

  it('returns null for a ONE-SIDED book — a legal object, but not quotable', async () => {
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(oneSided('bids', '100.00'));
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(oneSided('asks', '100.03'));
    const venue = gateVenue(() => ({}) as Clients);

    expect(await venue.bestQuote('BINANCE_FUTURE_ETH_USDT', 'BUY', '0.01')).toBeNull();
    expect(await venue.bestQuote('BINANCE_FUTURE_ETH_USDT', 'SELL', '0.01')).toBeNull();
  });

  it('returns null for a CROSSED book', async () => {
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(book('100.05', '100.01'));
    const venue = gateVenue(() => ({}) as Clients);
    expect(await venue.bestQuote('BINANCE_FUTURE_ETH_USDT', 'BUY', '0.01')).toBeNull();
  });

  it('returns null when the book fetch fails', async () => {
    vi.mocked(fetchVenueBook).mockRejectedValueOnce(new Error('venue down'));
    const venue = gateVenue(() => ({}) as Clients);
    expect(await venue.bestQuote('BINANCE_FUTURE_ETH_USDT', 'BUY', '0.01')).toBeNull();
  });

  it('applies the Hyperliquid 5-sig-fig cap in the safe direction', async () => {
    vi.mocked(fetchVenueBook).mockResolvedValueOnce(book('61717.85', '61717.9'));
    const venue = gateVenue(() => ({}) as Clients);
    expect(await venue.bestQuote('HYPERLIQUID_FUTURE_ETH_USDC', 'BUY', '0.01')).toBe('61717');
  });
});

describe('gateVenue reference-book validation', () => {
  it('rejects a crossed reference for four-leg sizing while preserving ordinary behavior', async () => {
    vi.mocked(fetchVenueBook).mockResolvedValue(book(100.05, 100.01));
    const venue = gateVenue(() => ({}) as Clients);
    expect(await venue.refPrice('BINANCE_FUTURE_ETH_USDT', true)).toBeNull();
    expect(await venue.refPrice('BINANCE_FUTURE_ETH_USDT')).toBe('100.03');
  });

  it.each([['0', '100'], ['100', '100'], ['NaN', '101']])('rejects invalid reference levels %s/%s', async (bid, ask) => {
    vi.mocked(fetchVenueBook).mockResolvedValue(book(bid, ask));
    const venue = gateVenue(() => ({}) as Clients);
    expect(await venue.refPrice('BINANCE_FUTURE_ETH_USDT', true)).toBeNull();
  });

  it('returns a valid reference midpoint from parsed decimal levels', async () => {
    vi.mocked(fetchVenueBook).mockResolvedValue(book('100', '102'));
    const venue = gateVenue(() => ({}) as Clients);
    expect(await venue.refPrice('BINANCE_FUTURE_ETH_USDT', true)).toBe('101');
  });
});
