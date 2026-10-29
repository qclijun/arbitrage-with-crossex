import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { FundingBoard } from '../api/fundingOpportunities';
import { fundingBoard } from '../test/fundingBoard';
import { env, server } from '../test/server';
import { FundingOpportunitiesPanel } from './FundingOpportunitiesPanel';

function renderWithClient(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

/** Serves `board` (or a per-request answer) and records every request the page makes. */
function serve(board: FundingBoard | ((url: URL) => FundingBoard) = fundingBoard()) {
  const urls: URL[] = [];
  const spreads: URL[] = [];
  server.use(
    http.get('/api/funding/opportunities', ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      return HttpResponse.json(env(typeof board === 'function' ? board(url) : board));
    }),
    http.get('/api/funding-spreads', ({ request }) => {
      spreads.push(new URL(request.url));
      return HttpResponse.json(env({ rows: [], feeds: [], assumedFeeTier: null }));
    }),
  );
  return { urls, spreads };
}

const table = () => screen.getByRole('table', { name: 'Directed funding pairs' });
const detail = () => screen.getByRole('complementary', { name: 'Candidate detail' });

describe('FundingOpportunitiesPanel', () => {
  it('ranks every directed pair on the left and details the selected one on the right, with no way to open', async () => {
    serve();
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    const rows = within(table()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('1');
    expect(rows[0]).toHaveTextContent('BINANCE');
    expect(rows[0]).toHaveTextContent('43.80%');
    expect(rows[0]).toHaveTextContent('Current reversed');
    // Negative and UNKNOWN rows stay listed; UNKNOWN is never a number.
    expect(rows[1]).toHaveTextContent('-43.80%');
    expect(rows[2]).toHaveTextContent('UNSUPPORTED');
    expect(rows[3]).toHaveTextContent('UNKNOWN');
    expect(rows[3]).toHaveTextContent('Observe only');

    const d = detail();
    expect(d).toHaveTextContent('Short BINANCE BTCUSDT');
    expect(d).toHaveTextContent('Long BYBIT BTCUSDT');
    expect(d).toHaveTextContent('Direction is fixed');
    expect(within(d).getAllByRole('row').slice(1).map((r) => r.firstChild?.textContent)).toEqual(['7d', '30d', '90d', '180d', '365d']);
    expect(d).toHaveTextContent('-10.95%');
    expect(d).toHaveTextContent('a hint only');
    expect(d).toHaveTextContent('Costs and sizing: UNKNOWN');
    expect(screen.getByText(/Manual opening is not enabled/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open|preview|submit|confirm/i })).not.toBeInTheDocument();
  });

  it('tells unsupported from UNKNOWN in the detail, and names execution limits apart from history', async () => {
    serve();
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    fireEvent.click(within(table()).getByRole('button', { name: /ETHUSDT/ }));
    expect(detail()).toHaveTextContent('UNSUPPORTED');
    expect(detail()).toHaveTextContent('long: the source cannot serve this window');
    fireEvent.click(within(table()).getByRole('button', { name: /1000PEPEUSDT/ }));
    expect(detail()).toHaveTextContent('UNKNOWN');
    expect(detail()).toHaveTextContent('PEPE is not a supported coin');
    expect(detail()).toHaveTextContent('short: not a one-coin contract');
  });

  it('asks the server for each window, filter and page, carrying the ranking fingerprint only when paging', async () => {
    const { urls } = serve(fundingBoard({ matched: 120 }));
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    expect(urls.at(-1)?.searchParams.get('days')).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(urls.at(-1)?.searchParams.get('days')).toBe('7'));
    fireEvent.change(screen.getByLabelText('Coin'), { target: { value: 'BTC' } });
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'OKX' } });
    fireEvent.click(screen.getByLabelText('Positive spread only'));
    await waitFor(() => expect(urls.at(-1)?.search).toBe('?days=7&offset=0&underlying=BTC&venue=OKX&positive=1'));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(urls.at(-1)?.searchParams.get('offset')).toBe('50'));
    expect(urls.at(-1)?.searchParams.get('rankingId')).toBe('a'.repeat(64));
  });

  it('when the ranking changed under a page, says so and shows page one', async () => {
    serve((url) => fundingBoard({ matched: 120, rankingChanged: url.searchParams.has('rankingId'), rankingId: 'b'.repeat(64) }));
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText(/The ranking changed while you were paging/)).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });

  it('explains a cold start, an unwired mapping and a failed refresh rather than showing an empty market', async () => {
    serve(fundingBoard({
      rows: [], candidateCount: 0, matched: 0, rankedCount: 0, snapshotId: null,
      history: { state: 'cold', snapshotId: null, cutoff: null, cutoffBehind: null, publishedAt: null, refreshing: true,
        lastRound: { startedAt: 1, finishedAt: 2, cutoff: 0, outcome: 'failed', reason: 'round-error', requests: 0, venues: {} } },
      contracts: { state: 'unwired', at: null, lastAttempt: null, count: 0, unpaired: [] }, feeds: [],
    }));
    renderWithClient(<FundingOpportunitiesPanel />);
    expect(await screen.findByText(/No proven contract mapping is wired yet/)).toBeInTheDocument();
    expect(screen.getByText(/No funding history has been published yet/)).toBeInTheDocument();
    expect(screen.getByText(/last history refresh failed/i)).toBeInTheDocument();
    expect(screen.getByText(/No candidates/)).toBeInTheDocument();
  });

  it('keeps the current-rate table folded away, and it fetches nothing until opened', async () => {
    const { spreads } = serve();
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    expect(spreads).toHaveLength(0);
    fireEvent.click(screen.getByText(/Current rates \(unranked/));
    await waitFor(() => expect(spreads).toHaveLength(1));
  });
});
