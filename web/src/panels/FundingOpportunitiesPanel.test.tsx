import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { FundingBoard } from '../api/fundingOpportunities';
import { fundingBoard } from '../test/fundingBoard';
import { fundingPreview, fundingReceipt } from '../test/fundingPreview';
import { seedSubmission } from '../test/fundingOrderForm';
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
  it('ranks every directed pair on the left and details the selected one on the right, opening only through its preview form', async () => {
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
    // The status names the coverage itself: UNSUPPORTED is not UNKNOWN.
    expect(rows[2].lastChild).toHaveTextContent('UNSUPPORTED');
    expect(rows[2].lastChild).not.toHaveTextContent('UNKNOWN');
    expect(rows[3]).toHaveTextContent('UNKNOWN');
    expect(rows[3]).toHaveTextContent('Observe only');

    const d = detail();
    expect(d).toHaveTextContent('Short BINANCE BTCUSDT');
    expect(d).toHaveTextContent('Long BYBIT BTCUSDT');
    expect(d).toHaveTextContent('Direction is fixed');
    expect(within(d).getAllByRole('row').slice(1).map((r) => r.firstChild?.textContent)).toEqual(['7d', '30d', '90d', '180d', '365d']);
    expect(d).toHaveTextContent('-10.95%');
    // A current quote shows its exact rate and when it was read.
    expect(d).toHaveTextContent('Short 0.00125% / 1h');
    expect(d).toHaveTextContent(/read (\d\d-\d\d )?\d\d:\d\d:\d\d/);
    expect(d).toHaveTextContent('a hint only');
    expect(d).toHaveTextContent('Costs, sizing and admission are known only from a preview');
    expect(screen.getByText(/Manual opening is not enabled/)).toBeInTheDocument();
    // Opening goes only through the preview form of this exact pair; nothing is holdable before a preview.
    expect(within(d).getByRole('group', { name: 'Open this pair' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hold to open' })).not.toBeInTheDocument();
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

  it('has no current-rate table and never asks for one', async () => {
    const { spreads } = serve();
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    expect(screen.queryByText(/Current rates/)).not.toBeInTheDocument();
    expect(spreads).toHaveLength(0);
  });

  it('never rounds a real non-zero figure to zero, and names a failed first contract read', async () => {
    const board = fundingBoard({ contracts: { state: 'cold', at: null, lastAttempt: { at: 1, ok: false }, count: 0, unpaired: [] } });
    board.rows[0].windows[1].netAnnualized = '0.00004';
    serve(board);
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    expect(within(table()).getAllByRole('row')[1]).toHaveTextContent('0.004%');
    expect(screen.getByText(/The contract list could not be read/)).toBeInTheDocument();
  });

  it('choosing another pair starts a fresh draft, and an unknown result on one pair blocks opening any other', async () => {
    serve(fundingBoard({ admission: { open: true, generation: 1, reason: 'open', changedAt: 1, enabledVersion: '9.9.9' } }));
    server.use(
      http.post('/api/funding/preview', () => HttpResponse.json(env(fundingPreview(), { ts: fundingPreview().readAt }))),
      http.post('/api/funding/intents', () => HttpResponse.error()),
      http.get('/api/funding/intents/:id', () => HttpResponse.json({ ok: false,
        error: { category: 'validation', label: 'intent-unknown', message: 'no intent', retryable: false } }, { status: 404 })),
      http.get('/api/funding/intents', () => HttpResponse.json(env([]))),
    );
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    const d = () => detail();
    fireEvent.change(within(d()).getByLabelText('Quantity (BTC)'), { target: { value: '0.01' } });
    fireEvent.click(within(table()).getByRole('button', { name: /BYBIT.*BINANCE/ }));
    expect(within(d()).getByLabelText('Quantity (BTC)')).toHaveValue('');
    fireEvent.change(within(d()).getByLabelText('Quantity (BTC)'), { target: { value: '0.01' } });
    fireEvent.click(within(d()).getByLabelText(/Maker: long/));
    fireEvent.change(within(d()).getByLabelText('Short leverage'), { target: { value: '2' } });
    fireEvent.change(within(d()).getByLabelText('Long leverage'), { target: { value: '2' } });
    fireEvent.change(within(d()).getByLabelText('Hold days'), { target: { value: '7' } });
    fireEvent.click(within(d()).getByRole('button', { name: 'Preview' }));
    await within(d()).findByRole('region', { name: 'Preview' });
    fireEvent.click(within(d()).getByLabelText(/I authorize converting/));
    fireEvent.click(within(d()).getByLabelText('I accept the risks listed above.'));
    fireEvent.pointerDown(within(d()).getByRole('button', { name: 'Hold to open' }));
    expect(await within(d()).findByText(/no known result yet/, undefined, { timeout: 3_000 })).toBeInTheDocument();
    fireEvent.click(within(table()).getAllByRole('button', { name: /BINANCE.*BYBIT/ })[0]);
    expect(within(d()).getByText(/has no known result yet: no new open from this page/)).toBeInTheDocument();
    expect(within(d()).getByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('restores every sent intent after a reload: each pair shows its own, and one unknown result blocks a new open anywhere', async () => {
    serve(fundingBoard({ admission: { open: true, generation: 1, reason: 'open', changedAt: 1, enabledVersion: '9.9.9' } }));
    const board = fundingBoard();
    const [first, second] = board.rows;
    seedSubmission('intent-1', first.id, 1);
    seedSubmission('intent-2', second.id, 2);
    server.use(
      http.get('/api/funding/intents/:id', ({ params }) => (params.id === 'intent-1'
        ? HttpResponse.json({ ok: false, error: { category: 'validation', label: 'intent-unknown', message: 'no intent', retryable: false } }, { status: 404 })
        : HttpResponse.json(env(fundingReceipt('intent-2', { mode: 'OPENING', aFilled: '0.002' }))))),
      http.get('/api/funding/intents', () => HttpResponse.json(env([]))),
    );
    renderWithClient(<FundingOpportunitiesPanel />);
    await screen.findByRole('table', { name: 'Directed funding pairs' });
    const sent = await screen.findByRole('list', { name: 'Sent intents' });
    await waitFor(() => expect(sent).toHaveTextContent(/intent-2 .* OPENING · maker 0.002/));
    expect(sent).toHaveTextContent(/intent-1 .* result not known yet/);
    expect(within(detail()).getByText(/Intent intent-1 has no known result yet: not accepted so far/)).toBeInTheDocument();
    fireEvent.click(within(table()).getByRole('button', { name: /BYBIT.*BINANCE/ }));
    expect(await within(detail()).findByText(/Accepted as intent intent-2/)).toBeInTheDocument();
    expect(within(detail()).queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    fireEvent.click(within(table()).getByRole('button', { name: /ETHUSDT/ }));
    expect(within(detail()).getByText(/Intent intent-1 has no known result yet: no new open/)).toBeInTheDocument();
    expect(within(detail()).getByRole('button', { name: 'Preview' })).toBeDisabled();
  });
});

it('shows mapping refusals explicitly so an incomplete contract list is not mistaken for the whole market', async () => {
  const board = fundingBoard();
  board.contracts.rejected = [{ symbol: 'GATE_FUTURE_BTC_USDT', reason: 'native-source-unwired' }];
  serve(board);
  renderWithClient(<FundingOpportunitiesPanel />);
  expect(await screen.findByText(/1 CrossEx contracts could not be mapped/)).toBeInTheDocument();
  expect(screen.getByText(/GATE_FUTURE_BTC_USDT/)).toHaveTextContent('native-source-unwired');
});
