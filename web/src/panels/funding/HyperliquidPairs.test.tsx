import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { boardRow, fundingBoard } from '../../test/fundingBoard';
import { env, server } from '../../test/server';
import { FundingOpportunitiesPanel } from '../FundingOpportunitiesPanel';

it('shows the HL/OKX estimates in both directions and explains why a ranked pair cannot open', async () => {
  const forward = boardRow('ETH', 'HYPERLIQUID ETH', 'OKX ETH-USDT-SWAP', 1, '0.0657', {
    short: { venue: 'HYPERLIQUID', contractId: 'ETH', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC' },
    rateEstimate: { short: { price: 'oracle', settlement: 'USDC' }, long: { price: 'mark', settlement: 'USDT' } },
    executionBlockers: ['funding-valuation-unnormalized'],
  });
  const reverse = boardRow('ETH', 'OKX ETH-USDT-SWAP', 'HYPERLIQUID ETH', 2, '-0.0657', {
    long: forward.short,
    rateEstimate: { short: { price: 'mark', settlement: 'USDT' }, long: { price: 'oracle', settlement: 'USDC' } },
    executionBlockers: ['funding-valuation-unnormalized'],
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
  expect(detail).toHaveTextContent('相同名义金额');
  expect(detail).toHaveTextContent('oracle · USDC');
  expect(detail).toHaveTextContent('mark · USDT');
  expect(detail).toHaveTextContent('并非实际现金收益或权益收益');
  expect(detail).toHaveTextContent('现金流计价尚未统一');
  expect(within(detail).queryByRole('button', { name: /Preview/ })).not.toBeInTheDocument();
  expect(within(detail).queryByRole('textbox', { name: 'Quantity (ETH)' })).not.toBeInTheDocument();
  await userEvent.click(within(rows[1]!).getByRole('button'));
  expect(detail).toHaveTextContent('Short OKX ETH-USDT-SWAP');
  expect(detail).toHaveTextContent('Long HYPERLIQUID ETH');
});
