import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { boardRow, fundingBoard } from '../../test/fundingBoard';
import { serveDefaults } from '../../test/fundingOrderForm';
import { env, server } from '../../test/server';
import { FundingOpportunitiesPanel } from '../FundingOpportunitiesPanel';

// The order form reads a touch and leverage caps for its defaults.
beforeEach(() => serveDefaults());

it('shows the HL/OKX estimates in both directions and lets a ranked pair open with USDC valued at par', async () => {
  const forward = boardRow('ETH', 'HYPERLIQUID ETH', 'OKX ETH-USDT-SWAP', 1, '0.0657', {
    short: { venue: 'HYPERLIQUID', contractId: 'ETH', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' },
    rateEstimate: { short: { price: 'oracle', settlement: 'USDC' }, long: { price: 'mark', settlement: 'USDT' } },
  });
  const reverse = boardRow('ETH', 'OKX ETH-USDT-SWAP', 'HYPERLIQUID ETH', 2, '-0.0657', {
    long: forward.short,
    rateEstimate: { short: { price: 'mark', settlement: 'USDT' }, long: { price: 'oracle', settlement: 'USDC' } },
  });
  const board = fundingBoard({ rows: [forward, reverse], candidateCount: 12, matched: 2, rankedCount: 2,
    admission: { open: true, generation: 1, reason: 'open', changedAt: 1, enabledVersion: '9.9.9' } });
  server.use(
    http.get('/api/funding/opportunities', () => HttpResponse.json(env(board))),
    http.get('/api/funding/intents', () => HttpResponse.json(env([]))),
  );
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <FundingOpportunitiesPanel />
  </QueryClientProvider>);
  const table = await screen.findByRole('table', { name: 'Directed funding pairs' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('6.57%');
  expect(rows[1]).toHaveTextContent('-6.57%');
  for (const row of rows) {
    expect(row).toHaveTextContent('费率差估算');
    expect(row).toHaveTextContent('Ranked');
  }
  const detail = screen.getByRole('complementary', { name: 'Candidate detail' });
  expect(within(detail).getByTitle(/相同名义金额/)).toHaveTextContent('费率差估算');
  expect(detail).toHaveTextContent('oracle · USDC');
  expect(detail).toHaveTextContent('mark · USDT');
  expect(within(detail).getByTitle(/并非实际现金收益或权益收益/)).toHaveAttribute('title', expect.stringContaining('1 USDC = 1 USDT = 1 USD'));
  expect(detail).not.toHaveTextContent('无法开仓');
  expect(within(detail).getByRole('textbox', { name: 'Quantity (ETH)' })).toBeInTheDocument();
  await userEvent.click(within(rows[1]!).getByRole('button'));
  expect(detail).toHaveTextContent('Short OKX ETH-USDT-SWAP');
  expect(detail).toHaveTextContent('Long HYPERLIQUID ETH');
});
