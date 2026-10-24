import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { buildFundingSpreads } from '../../../src/core/funding/spreads';
import { env, server } from '../test/server';
import { FundingSpreadsPanel } from './FundingSpreadsPanel';

function renderWithClient(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

const rate = (base: string, r: number, price: number) => ({ base, rate: r, intervalHours: 8, markPrice: price, nextFundingTime: null });
const listing = (venue: string, base: string) => ({ venue, base, symbol: `${venue}_FUTURE_${base}_USDT` });

function serve() {
  const rows = buildFundingSpreads(
    [listing('GATE', 'FAST'), listing('BINANCE', 'FAST'), listing('GATE', 'SLOW'), listing('BINANCE', 'SLOW'), listing('GATE', 'FAKE'), listing('BINANCE', 'FAKE'), listing('GATE', 'NOFEE'), listing('LIGHTER', 'NOFEE')],
    new Map([
      ['GATE', [rate('FAST', 0.001, 1), rate('SLOW', 0.00002, 1), rate('FAKE', 0.002, 1), rate('NOFEE', 0.00002, 1)]],
      ['BINANCE', [rate('FAST', 0, 1), rate('SLOW', 0, 1), rate('FAKE', 0, 9)]],
      ['LIGHTER', [rate('NOFEE', 0, 1)]],
    ]),
    ['GATE', 'BINANCE'].map((v) => ({ exchangeType: v, futureMakerFee: '0', futureTakerFee: '0.0005' })),
  );
  const feeds = [
    { venue: 'BINANCE', ok: true, count: 3, observedAt: Date.now(), stale: false, error: null },
    { venue: 'OKX', ok: false, count: 0, observedAt: null, stale: false, error: 'network' },
    { venue: 'DERIBIT', ok: false, count: 0, observedAt: null, stale: false, error: 'no-feed' },
    { venue: 'GATE', ok: true, count: 3, observedAt: Date.now(), stale: true, error: null },
  ];
  server.use(http.get('/api/funding-spreads', () => HttpResponse.json(env({ rows, feeds, assumedFeeTier: 'vip0' }, { observedAt: Date.now() }))));
}

describe('FundingSpreadsPanel', () => {
  it('keeps rows that pay back within the window, hides price mismatches, and names failed feeds', async () => {
    serve();
    renderWithClient(<FundingSpreadsPanel />);
    // FAST: 0.1%/8h ≈ 109.5% APR → 0.2% round trip pays back in well under a day.
    expect(await screen.findByText('FAST')).toBeInTheDocument();
    // SLOW: ≈ 2.2% APR → ~33 days, outside the default 7-day window.
    expect(screen.queryByText('SLOW')).not.toBeInTheDocument();
    expect(screen.queryByText('FAKE')).not.toBeInTheDocument();
    // No fee row for Lighter: payback can't be judged, so the window must not hide it.
    expect(screen.getByText('NOFEE')).toBeInTheDocument();
    expect(screen.getByText(/OKX funding unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/DERIBIT: no public funding feed/)).toBeInTheDocument();
    expect(screen.getByText('GATE rates stale')).toBeInTheDocument();
    expect(screen.getByText(/as of/)).toBeInTheDocument();
    expect(screen.getByText(/Payback assumes VIP0 fees/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Payback within'), { target: { value: '' } });
    expect(screen.getByText('SLOW')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Hide price mismatches'));
    expect(screen.getByText('FAKE')).toBeInTheDocument();
    expect(screen.getByText('Price mismatch')).toBeInTheDocument();
  });
});
