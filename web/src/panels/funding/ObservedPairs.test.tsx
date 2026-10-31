import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { fundingBoard } from '../../test/fundingBoard';
import { env, server } from '../../test/server';
import { FundingOpportunitiesPanel } from '../FundingOpportunitiesPanel';

it('explains observed figures and schedule gaps in the list and detail without a rank', async () => {
  const board = fundingBoard();
  const row = board.rows[0]!;
  row.rank = null;
  row.windows.forEach((w) => {
    w.eligible = false;
    w.coverage = 'unknown';
    w.netTotal = w.netAnnualized = null;
    w.reasons = ['history-unknown', 'short:schedule-unverified', 'long:schedule-unverified'];
    Object.assign(w, { observed: { netTotal: '0.0021', netAnnualized: '0.1095', fresh: true } });
    for (const leg of Object.values(w.legs!)) {
      leg.total = leg.annualized = null;
      leg.coverage = 'unknown';
      leg.reasons = ['schedule-unverified'];
      Object.assign(leg, { observed: { total: '0.0042', annualized: '0.219', events: 21, firstAt: w.start! + 1, lastAt: w.cutoff } });
    }
  });
  board.rows = [row];
  board.rankedCount = 0;
  server.use(http.get('/api/funding/opportunities', () => HttpResponse.json(env(board))));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <FundingOpportunitiesPanel />
  </QueryClientProvider>);
  const table = await screen.findByRole('table', { name: 'Directed funding pairs' });
  const displayed = within(table).getAllByRole('row')[1]!;
  expect(displayed).toHaveTextContent('10.95%');
  expect(displayed).toHaveTextContent('Observed');
  expect(displayed).toHaveTextContent('Schedule unverified');
  expect(displayed).not.toHaveTextContent('UNKNOWN');
  const windows = within(screen.getByRole('complementary', { name: 'Candidate detail' })).getByRole('table', { name: 'History windows' });
  expect(windows).toHaveTextContent('0.21%');
  expect(windows).toHaveTextContent('21 settlements');
  expect(screen.getByTitle(/Observed figures use returned settlements/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Hold to open' })).not.toBeInTheDocument();
});
