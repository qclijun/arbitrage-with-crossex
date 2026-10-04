import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BorosCollateralResponse } from '../api/types';
import { CollateralPanel } from './CollateralPanel';

const mocks = vi.hoisted(() => ({ address: '0x' + '1'.repeat(40), query: {} as Record<string, unknown>, refetch: vi.fn() }));
vi.mock('./trackedAddress', () => ({ useTrackedAddress: () => ({ address: mocks.address }) }));
vi.mock('../api/queries', () => ({ useBorosCollateral: () => mocks.query }));
const snapshot = (): BorosCollateralResponse => ({ address: mocks.address, accountId: 0,
  observedAt: 1800000000000, stale: false, tokens: [{ symbol: 'ETH', tokenId: 2, priceUsd: 3000,
    cross: { marketAcc: 'pool', netBalance: .1, initialMargin: .08, maintenanceMargin: .04,
      availableInitialMargin: .012, activePositions: 2, imCoverage: 1.25, mmCoverage: 2.5 }, isolated: [] },
    { symbol: 'BTC', tokenId: 1, priceUsd: null, cross: null, isolated: [] },
    { symbol: 'USDT', tokenId: 3, priceUsd: null, cross: null, isolated: [] }] });
beforeEach(() => { mocks.refetch.mockClear(); mocks.query = { data: snapshot(), refetch: mocks.refetch }; });
describe('CollateralPanel', () => {
  it('shows official available margin and coverage, with manual read-only refresh', () => {
    render(<CollateralPanel />);
    expect(screen.getByText('0.012 ETH')).toBeInTheDocument();
    expect(screen.getByText('1.25×')).toBeInTheDocument();
    expect(screen.getByText('2.50×')).toBeInTheDocument();
    expect(screen.getByText('80.0%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /Deposit|Withdraw/ })).not.toBeInTheDocument();
  });
  it('labels old values when a background read fails', () => {
    mocks.query.isError = true;
    render(<CollateralPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('UNKNOWN');
    expect(screen.getByRole('status')).toHaveTextContent('Last successful snapshot');
    expect(screen.getByRole('status')).toHaveTextContent('Values below are old data');
  });
  it('does not turn a failed initial read into no balance', () => {
    mocks.query = { isError: true, refetch: mocks.refetch };
    render(<CollateralPanel />);
    expect(screen.queryByText('No balance in this token account.')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No successful snapshot');
  });
  it('never shows a different wallet snapshot', () => {
    mocks.query.data = { ...snapshot(), address: '0x' + '2'.repeat(40) };
    render(<CollateralPanel />);
    expect(screen.queryByText('0.012 ETH')).not.toBeInTheDocument();
  });
});
