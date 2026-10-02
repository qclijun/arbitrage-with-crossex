import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreshnessButton } from './FreshnessIndicator';

afterEach(cleanup);

describe('freshness during a failed Gate read', () => {
  it('shows an actionable error when no data has ever loaded', () => {
    const retry = vi.fn();
    render(<FreshnessButton dataUpdatedAt={0} staleError title="Refetch all panels" onRefetch={retry} />);
    fireEvent.click(screen.getByRole('button', { name: /fetch failed.*retry/i }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText('loading')).toBeNull();
  });

  it('keeps loading while the initial request is pending', () => {
    render(<FreshnessButton dataUpdatedAt={0} staleError={false} title="Refetch" onRefetch={() => {}} />);
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('keeps the last successful timestamp on a failed refresh', () => {
    render(<FreshnessButton dataUpdatedAt={Date.now() - 60_000} staleError title="Refetch" onRefetch={() => {}} />);
    expect(screen.getByRole('button', { name: /stale .*retrying/ })).toBeInTheDocument();
  });
});
