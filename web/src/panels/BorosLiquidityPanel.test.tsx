import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { bookInputs, evidence, LIQUIDITY_SCOPE, marketInputs } from '../../../src/core/boros/liquidity';
import { calculateLiquidityMetrics } from '../../../src/core/boros/liquidity-metrics';
import { env, server } from '../test/server';
import { BorosLiquidityPanel } from './BorosLiquidityPanel';

function renderWithClient(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

function snapshot(id = 197, book: unknown = { long: { ia: [50, 40], sz: ['1000000000000000000', '2000000000000000000'] }, short: { ia: [70], sz: ['4000000000000000000'] } }, age = 0) {
  const time = Date.now() - age;
  const inputs = marketInputs({ raw: { marketId: id, tokenId: 2, platform: { platformId: 'Binance', name: 'Binance' },
    metadata: { name: 'ETHUSDT', underlyingSymbol: 'ETH', fundingRateSymbol: 'ETHUSDT' },
    imData: { maturity: id === 197 ? 1793318400 : 1795996800 }, data: { volume24h: 123.5, notionalOI: 600.25 } }, collectedAt: time, sourceSyncStatus: null },
    { rows: [], pages: 1, resumeToken: null, completeness: 'complete', reason: [] }, 30000, []);
  const collateral = evidence({ value: { tokenId: 2, assetId: 'ETH', symbol: 'WETH', decimals: 18, address: null }, raw: {}, unit: 'collateral-identity', source: 'assets', marketKey: inputs.marketKey, collectedAt: time, sourceSyncStatus: null, ttlMs: 30000 });
  const parsed = bookInputs(book, id, time, 90000, []);
  return { ...inputs, collateral, book: parsed, metrics: calculateLiquidityMetrics(parsed, collateral) };
}
function serve(markets = [snapshot(), snapshot(198)]) {
  server.use(http.get('/api/boros/liquidity', () => HttpResponse.json(env({ scope: LIQUIDITY_SCOPE,
    coverage: evidence({ value: { returnedMarkets: markets.length, pages: 1, resumeToken: null }, raw: null, unit: 'market-list-coverage', source: 'markets', marketKey: null, collectedAt: Date.now(), sourceSyncStatus: null, ttlMs: 30000 }), markets }))));
}

describe('market liquidity API → metrics → page', () => {
  it('compares separate maturities and switches diagnostics without combining market quantities', async () => {
    serve();
    renderWithClient(<BorosLiquidityPanel />);
    const first = await screen.findByRole('button', { name: /Market 197/ });
    expect(screen.getByRole('button', { name: /Market 198/ })).toBeInTheDocument();
    fireEvent.click(first);
    const detail = screen.getByRole('region', { name: 'Market 197 diagnostics' });
    expect(within(detail).getByText('0.50%')).toBeInTheDocument();
    expect(within(detail).getAllByText('0.70%').length).toBeGreaterThan(0);
    expect(within(detail).getByText('20.00 APR bp')).toBeInTheDocument();
    expect(within(detail).getByText(/rolling 24h/)).toBeInTheDocument();
    expect(within(detail).getAllByText(/3 YU/).length).toBeGreaterThan(0);
    expect(within(detail).getAllByText(/PRICE_SOURCE_TIME_UNKNOWN/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Market 198/ }));
    expect(screen.getByRole('region', { name: 'Market 198 diagnostics' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Market 197 diagnostics' })).not.toBeInTheDocument();
  });
  it('distinguishes a complete empty side from missing data and retains independent source clocks', async () => {
    serve([snapshot(197, { long: { ia: [], sz: [] } })]);
    renderWithClient(<BorosLiquidityPanel />);
    const detail = await screen.findByRole('region', { name: 'Market 197 diagnostics' });
    expect(within(detail).getByText('0 YU')).toBeInTheDocument();
    expect(within(detail).getAllByText('UNKNOWN').length).toBeGreaterThan(0);
    expect(within(detail).getAllByText(/MISSING_OR_MISMATCHED_SIDE/).length).toBeGreaterThan(0);
    expect(within(detail).getAllByText(/Source time:/).length).toBeGreaterThan(0);
    expect(within(detail).getAllByText(/Collected:/).length).toBeGreaterThan(0);
  });
  it('marks expired values as STALE rather than presenting current depth', async () => {
    serve([snapshot(197, undefined, 120000)]);
    renderWithClient(<BorosLiquidityPanel />);
    const detail = await screen.findByRole('region', { name: 'Market 197 diagnostics' });
    expect(within(detail).getAllByText(/STALE/).length).toBeGreaterThan(0);
    expect(within(detail).getByText(/24h Volume/)).toBeInTheDocument();
  });
  it('marks retained data on refresh failure and performs only public GET requests', async () => {
    serve();
    const requests: { method: string; path: string }[] = [];
    const listener = ({ request }: { request: Request }) => requests.push({ method: request.method, path: new URL(request.url).pathname });
    server.events.on('request:start', listener);
    try {
      renderWithClient(<BorosLiquidityPanel />);
      await screen.findByRole('region', { name: 'Market 197 diagnostics' });
      server.use(http.get('/api/boros/liquidity', () => new HttpResponse(null, { status: 503 })));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Retained snapshot is STALE');
      expect(screen.getByRole('region', { name: 'Market 197 diagnostics' })).toBeInTheDocument();
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.every(r => r.method === 'GET' && r.path === '/api/boros/liquidity')).toBe(true);
    } finally { server.events.removeListener('request:start', listener); }
  });
});
