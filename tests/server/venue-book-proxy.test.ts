import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVenueBook } from '../../src/core/estimate/books';

const PROXY = 'http://127.0.0.1:17899';
const levels = { bids: [['100', '2']], asks: [['101', '3']] };
const originalAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  vi.unstubAllEnvs();
});

type Reply = { url: string; data?: unknown; method?: string; fail?: boolean };

// Replace only the HTTP transport; exercise request routing and book normalization.
function mockTransport(replies: Reply[], expectProxy = true): Reply[] {
  const pending = [...replies];
  axios.defaults.adapter = async (config) => {
    const agent = config.httpsAgent;
    const configuredRoute = config.proxy === false && agent?.proxy?.hostname === '127.0.0.1'
      && agent.proxy.port === '17899' && agent.proxy.protocol === 'http:' && agent.keepAlive === true;
    if (expectProxy ? !configuredRoute : config.proxy !== undefined) throw new Error('route unavailable');
    expect(config.timeout).toBe(2500);
    const index = pending.findIndex((item) => item.url === config.url
      && (item.method ?? 'get') === config.method);
    if (index < 0) throw new Error('unexpected request');
    const [reply] = pending.splice(index, 1);
    if (reply.fail) throw new Error('proxy unavailable');
    return { data: reply.data, status: 200, statusText: 'OK', headers: {}, config };
  };
  return pending;
}

describe('public venue books use the configured proxy', () => {
  it.each(['ETH', 'BTC'])('loads Binance %s through the proxy', async (base) => {
    vi.stubEnv('GATE_PROXY', PROXY);
    const pending = mockTransport([
      { url: `https://fapi.binance.com/fapi/v1/depth?symbol=${base}USDT&limit=100`, data: levels },
    ]);
    const book = await fetchVenueBook('BINANCE', base, 'USDT');
    expect(book?.bids).toEqual([[100, 2]]);
    expect(book?.asks).toEqual([[101, 3]]);
    expect(pending).toEqual([]);
  });

  it('loads Hyperliquid POST books through the same proxy', async () => {
    vi.stubEnv('GATE_PROXY', PROXY);
    const pending = mockTransport([
      { url: 'https://api.hyperliquid.xyz/info', method: 'post',
        data: { levels: [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]] } },
    ]);
    expect((await fetchVenueBook('HYPERLIQUID', 'ETH', 'USDC'))?.bids).toEqual([[100, 2]]);
    expect(pending).toEqual([]);
  });

  it('loads OKX instrument metadata and book through the same proxy', async () => {
    vi.stubEnv('GATE_PROXY', PROXY);
    const pending = mockTransport([
      { url: 'https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=ETH-USDT-SWAP', data: { data: [{ ctVal: '0.1' }] } },
      { url: 'https://www.okx.com/api/v5/market/books?instId=ETH-USDT-SWAP&sz=100', data: { data: [levels] } },
    ]);
    expect((await fetchVenueBook('OKX', 'ETH', 'USDT'))?.bids).toEqual([[100, 0.2]]);
    expect(pending).toEqual([]);
  });

  it('loads Lighter market discovery and book through the same proxy', async () => {
    vi.stubEnv('GATE_PROXY', PROXY);
    const pending = mockTransport([
      { url: 'https://mainnet.zklighter.elliot.ai/api/v1/orderBooks',
        data: { order_books: [{ symbol: 'ETH', market_id: 0, market_type: 'perp', status: 'active' }] } },
      { url: 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=0&limit=250',
        data: { bids: [{ price: '100', remaining_base_amount: '2' }], asks: [{ price: '101', remaining_base_amount: '3' }] } },
    ]);
    expect((await fetchVenueBook('LIGHTER', 'ETH', 'USDC'))?.bids).toEqual([[100, 2]]);
    expect(pending).toEqual([]);
  });

  it('preserves fetching when no proxy is configured', async () => {
    vi.stubEnv('GATE_PROXY', '');
    const pending = mockTransport([
      { url: 'https://fapi.binance.com/fapi/v1/depth?symbol=ETHUSDT&limit=100', data: levels },
    ], false);
    expect((await fetchVenueBook('BINANCE', 'ETH', 'USDT'))?.bids).toEqual([[100, 2]]);
    expect(pending).toEqual([]);
  });

  it('keeps proxy failures UNKNOWN rather than retrying through a different route', async () => {
    vi.stubEnv('GATE_PROXY', PROXY);
    const pending = mockTransport([
      { url: 'https://fapi.binance.com/fapi/v1/depth?symbol=ETHUSDT&limit=100', fail: true },
    ]);
    expect(await fetchVenueBook('BINANCE', 'ETH', 'USDT')).toBeNull();
    expect(pending).toEqual([]);
  });
});
