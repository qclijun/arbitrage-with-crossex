import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { fundingBoard } from '../../test/fundingBoard';
import { env, server } from '../../test/server';
import { FundingOpportunitiesPanel } from '../FundingOpportunitiesPanel';

it('labels ranked inferred schedules and displays the inferred leg intervals', async () => {
  const board = fundingBoard();
  board.rows = [board.rows[0]!];
  for (const w of board.rows[0]!.windows) for (const leg of Object.values(w.legs!)) {
    leg.cadence = { basis: 'inferred', intervals: [8], samples: 1095 };
  }
  server.use(http.get('/api/funding/opportunities', () => HttpResponse.json(env(board))));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <FundingOpportunitiesPanel />
  </QueryClientProvider>);
  const table = await screen.findByRole('table', { name: 'Directed funding pairs' });
  expect(table).toHaveTextContent('Ranked · inferred');
  const detail = screen.getByRole('complementary', { name: 'Candidate detail' });
  expect(detail).toHaveTextContent('Cadence short 8h (inferred) · long 8h (inferred)');
  expect(within(detail).getByRole('table', { name: 'History windows' })).toHaveTextContent('Complete · inferred');
  expect(screen.getByText(/Manual opening is not enabled/)).toBeInTheDocument();
});
