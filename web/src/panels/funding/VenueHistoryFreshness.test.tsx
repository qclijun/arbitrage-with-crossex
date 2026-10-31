import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import type { SettlementBoard } from '../../api/fundingSettlements';
import { env, server } from '../../test/server';
import { VenueSettlementHistory } from './VenueSettlementHistory';

it.each([
  ['budget-exhausted', '预算耗尽'], ['timeout', '读取超时'], ['rate-limited', '交易所限流'],
])('shows %s for the affected window with original evidence times, then clears it after recovery', async (reason, label) => {
  const oldCutoff = Date.UTC(2026, 9, 1, 10);
  const cutoff = oldCutoff + 3_600_000;
  const data: SettlementBoard = { evaluatedAt: cutoff + 60_000, snapshotId: 'fixture', offset: 0, limit: 20, matched: 1,
    options: { underlyings: ['BTC'], venues: ['HYPERLIQUID'] }, rows: [{
      venue: 'HYPERLIQUID', contractId: 'BTC', symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', assetCode: 'BTC',
      backfill: { cutoff: oldCutoff, completeThroughDays: 180, pendingDays: 365, pagesRead: 50 },
      lastAttempt: { at: cutoff + 60_000, outcome: 'error', reason },
      windows: [7, 30, 90, 180, 365].map((days) => ({ days: days as 7 | 30 | 90 | 180 | 365,
        cutoff: days === 365 ? oldCutoff : cutoff, coverage: 'complete', fresh: days !== 365,
        total: '0.01', annualized: '0.1', observed: null, verifiedAt: (days === 365 ? oldCutoff : cutoff) + 60_000,
        lastAttempt: { at: cutoff + 60_000, outcome: 'error', reason }, reasons: days === 365 ? [reason, 'history-cutoff-behind'] : [],
      })),
    }] };
  server.use(http.get('/api/funding/settlements', () => HttpResponse.json(env(data))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><VenueSettlementHistory /></QueryClientProvider>);
  const table = await screen.findByRole('table', { name: 'Venue historical settlements' });
  const cells = within(table).getAllByRole('row')[1]!.querySelectorAll('td');
  expect(cells[1]).toHaveTextContent('Fresh');
  expect(cells[5]).toHaveTextContent('Stale');
  expect(cells[5]).toHaveTextContent(label);
  expect(cells[5]).toHaveTextContent('Cutoff');
  expect(cells[5]).toHaveTextContent('Verified');
  expect(cells[5]).toHaveTextContent('Last try');
  expect(cells[0]).toHaveTextContent('180d');
  expect(cells[0]).toHaveTextContent('365d');
  expect(cells[0]).toHaveTextContent('50');
  const window = data.rows[0]!.windows[4]!;
  Object.assign(window, { cutoff, verifiedAt: cutoff + 120_000, fresh: true, reasons: [], lastAttempt: { at: cutoff + 120_000, outcome: 'success' } });
  data.rows[0]!.lastAttempt = window.lastAttempt!;
  data.rows[0]!.backfill = { cutoff, completeThroughDays: 365, pendingDays: null, pagesRead: 90 };
  await client.invalidateQueries({ queryKey: ['funding', 'settlements'] });
  await waitFor(() => expect(cells[5]).toHaveTextContent('Fresh'));
  expect(cells[5]).not.toHaveTextContent(label);
  expect(cells[5]).not.toHaveTextContent('Stale');
});
