import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import type { SettlementBoard } from '../../api/fundingSettlements';
import { env, server } from '../../test/server';
import { VenueSettlementHistory } from './VenueSettlementHistory';

const cutoff = Date.UTC(2026, 9, 31);
const board = (): SettlementBoard => ({ evaluatedAt: cutoff + 60_000, snapshotId: 'observed', offset: 0, limit: 20, matched: 3,
  options: { underlyings: ['BTC'], venues: ['ASTER', 'HYPERLIQUID', 'OKX'] },
  rows: ['ASTER', 'HYPERLIQUID', 'OKX'].map((venue) => ({ venue, contractId: venue === 'HYPERLIQUID' ? 'BTC' : venue === 'OKX' ? 'BTC-USDT-SWAP' : 'BTCUSDT',
    symbol: `${venue}_FUTURE_BTC_${venue === 'HYPERLIQUID' ? 'USDC' : 'USDT'}`, assetCode: 'BTC', lastAttempt: { at: cutoff + 60_000, outcome: 'success' },
    windows: [7, 30, 90, 180, 365].map((days) => ({ days: days as 7 | 30 | 90 | 180 | 365, cutoff, coverage: 'unknown', fresh: true, restored: false,
      total: null, annualized: null, observed: { total: venue === 'HYPERLIQUID' ? '0' : '-0.01', annualized: venue === 'HYPERLIQUID' ? '0' : '-0.12',
        events: 21, firstAt: cutoff - 24 * 3_600_000, lastAt: cutoff }, reasons: ['schedule-unverified'], verifiedAt: cutoff + 60_000 })),
  })),
});
function show(data = board()) {
  server.use(http.get('/api/funding/settlements', () => HttpResponse.json(env(data))));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VenueSettlementHistory />
  </QueryClientProvider>);
}

it('shows unverified native history values, including zero/negative and OKX long windows, without an order action', async () => {
  show();
  const table = await screen.findByRole('table', { name: 'Venue historical settlements' });
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(4);
  expect(rows[1]).toHaveTextContent('ASTER');
  expect(within(rows[1]).getAllByText('-12.00%')).toHaveLength(5);
  expect(within(rows[2]).getAllByText('0.00%')).toHaveLength(5);
  expect(rows[3]).toHaveTextContent('BTC-USDT-SWAP');
  expect(within(rows[3]).getAllByText('-12.00%')).toHaveLength(5);
  expect(screen.getByText(/completeness is not proven/)).toBeInTheDocument();
  expect(rows[1]).toHaveTextContent('21 settlements · Unverified');
  expect(screen.queryByRole('button', { name: /open|preview/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Cumulative totals'));
  expect(within(rows[1]).getAllByText('-1.00%')).toHaveLength(5);
  expect(screen.getByRole('columnheader', { name: '365d total' })).toBeInTheDocument();
});

it('keeps missing data empty and marks old observations stale', async () => {
  const data = board();
  data.rows[0].windows[0].observed = null;
  data.rows[0].windows[1].fresh = false;
  show(data);
  const table = await screen.findByRole('table', { name: 'Venue historical settlements' });
  const row = within(table).getAllByRole('row')[1];
  expect(row).toHaveTextContent('Not collected');
  expect(row).toHaveTextContent('Unverified · Stale');
  expect(within(row).getAllByText('-12.00%')).toHaveLength(4);
});

it('removes the completeness marker only from verified windows', async () => {
  const data = board();
  for (const window of data.rows[1].windows) {
    window.coverage = 'complete'; window.total = '0'; window.annualized = '0'; window.reasons = [];
  }
  show(data);
  const table = await screen.findByRole('table', { name: 'Venue historical settlements' });
  const rows = within(table).getAllByRole('row');
  expect(rows[1]).toHaveTextContent('Unverified');
  expect(rows[2]).not.toHaveTextContent('Unverified');
  expect(within(rows[2]).getAllByText('0.00%')).toHaveLength(5);
  expect(rows[3]).toHaveTextContent('Unverified');
  expect(screen.queryByRole('button', { name: /open|preview/i })).not.toBeInTheDocument();
});

it('filters and pages native history independently of the directed-pair ranking', async () => {
  const data = board();
  data.matched = 45;
  const urls: URL[] = [];
  server.use(http.get('/api/funding/settlements', ({ request }) => {
    const url = new URL(request.url); urls.push(url);
    return HttpResponse.json(env({ ...data, offset: Number(url.searchParams.get('offset')) }));
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><VenueSettlementHistory /></QueryClientProvider>);
  await screen.findByRole('table', { name: 'Venue historical settlements' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next history page' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Next history page' }));
  await waitFor(() => expect(urls.at(-1)?.searchParams.get('offset')).toBe('20'));
  fireEvent.change(screen.getByLabelText('History venue'), { target: { value: 'HYPERLIQUID' } });
  await waitFor(() => expect(urls.at(-1)?.searchParams.get('venue')).toBe('HYPERLIQUID'));
  expect(urls.at(-1)?.searchParams.get('offset')).toBe('0');
  fireEvent.change(screen.getByLabelText('Native asset code'), { target: { value: 'BTC' } });
  await waitFor(() => expect(urls.at(-1)?.searchParams.get('underlying')).toBe('BTC'));
});
