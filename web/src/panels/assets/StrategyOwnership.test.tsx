import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClaimRow } from '../../../../src/engine/claim-types';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { StrategyOwnership } from './StrategyOwnership';

const long = 'BINANCE_FUTURE_ETH_USDT';
const short = 'OKX_FUTURE_ETH_USDT';
let row: ClaimRow;
let previews: unknown[];
let confirmations: number;
beforeEach(() => {
  previews = []; confirmations = 0;
  row = { id: 'claim-one', status: 'preview', createdAt: 100, expiresAt: 10100, appliedAt: null, reason: null,
    input: { kind: 'funding-two-leg', legs: [{ contract: long, side: 'long', qty: '0.36' }, { contract: short, side: 'short', qty: '0.36' }], boros: [] },
    preview: { fingerprint: 'proof', readAt: 100, boros: [], legs: [
      { contract: long, side: 'long', qty: '0.36', actual: '4.03', available: '4.03', remaining: '3.67' },
      { contract: short, side: 'short', qty: '0.36', actual: '-4.03', available: '4.03', remaining: '3.67' },
    ], attribution: { funding: null, fees: null, pnl: null, equityReturn: null, reason: 'UNKNOWN: historical slice amounts are unproven.' } } };
  server.use(
    http.get('/api/slices/claim-evidence', () => HttpResponse.json(env({ readAt: 100, positions: { [long]: '4.03', [short]: '-4.03' }, contracts: [long, short], openOrders: [], boros: null }))),
    http.get('/api/slices', () => HttpResponse.json(env({ slices: [], contracts: [] }))),
    http.get('/api/slices/claims', () => HttpResponse.json(env(row.status === 'preview' ? [] : [row]))),
    http.get('/api/slices/claims/:id', () => HttpResponse.json(env(row))),
    http.post('/api/slices/claims/preview', async ({ request }) => { previews.push(await request.json()); return HttpResponse.json(env(row)); }),
    http.post('/api/slices/claims/:id/confirm', () => { confirmations++; row = { ...row, status: 'pending' }; return HttpResponse.json(env(row), { status: 202 }); }),
    http.post('/api/slices/claims/:id/discard', () => { row = { ...row, status: 'rejected', reason: 'Preview discarded by user' }; return HttpResponse.json(env(row)); }),
  );
});
async function fill() {
  await screen.findByRole('option', { name: `${long} long — 4.03` });
  fireEvent.change(screen.getByLabelText('Long contract'), { target: { value: long } });
  fireEvent.change(screen.getByLabelText('Short contract'), { target: { value: short } });
  fireEvent.change(screen.getByLabelText('Base quantity to claim'), { target: { value: '0.36' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview ownership' }));
}
describe('strategy ownership', () => {
  it('restores the original unconfirmed preview after reload without creating another identity', async () => {
    server.use(http.get('/api/slices/claims', () => HttpResponse.json(env([{ ...row, confirmationPossible: true }]))));
    renderWithClient(<StrategyOwnership />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm current ownership' }));
    await waitFor(() => expect(confirmations).toBe(1));
    expect(previews).toEqual([]);
  });
  it('requires explicit partial selection, previews both remainders and keeps unknown cash flows separate', async () => {
    renderWithClient(<StrategyOwnership />);
    await fill();
    expect(await screen.findAllByText(/3.67 remaining unattributed/)).toHaveLength(2);
    expect(previews).toEqual([row.input]);
    expect(screen.getByText(/historical slice amounts are unproven/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm current ownership' }));
    await waitFor(() => expect(confirmations).toBe(1));
    expect(await screen.findByText(/Pending engine verification/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview ownership' })).toBeDisabled();
  });
  it('keeps the same command on a lost confirmation response and looks it up', async () => {
    server.use(http.post('/api/slices/claims/:id/confirm', () => {
      confirmations++; row = { ...row, status: 'applied', appliedAt: 200 }; return HttpResponse.error();
    }));
    renderWithClient(<StrategyOwnership />); await fill();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm current ownership' }));
    expect(await screen.findByText(/Applied at/)).toBeInTheDocument();
    expect(confirmations).toBe(1);
    expect(previews).toHaveLength(1);
  });
  it('does not treat a still-unconfirmed lookup as proof that a late confirmation cannot arrive', async () => {
    server.use(
      http.post('/api/slices/claims/:id/confirm', () => HttpResponse.error()),
      http.get('/api/slices/claims/:id', () => HttpResponse.json(env({ ...row, confirmationPossible: true }))),
    );
    renderWithClient(<StrategyOwnership />); await fill();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm current ownership' }));
    expect(await screen.findByText(/Confirmation outcome unknown/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview ownership' })).toBeDisabled();
    server.use(http.get('/api/slices/claims/:id', () => HttpResponse.json(env({ ...row, confirmationPossible: false }))));
    fireEvent.click(screen.getByRole('button', { name: 'Query original claim' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review another quantity' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview ownership' })).toBeEnabled());
  });
  it('restores pending commands from the ledger and blocks a new claim until resolved', async () => {
    row.status = 'pending';
    renderWithClient(<StrategyOwnership />);
    expect(await screen.findByText(/Pending engine verification/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview ownership' })).toBeDisabled();
    expect(previews).toEqual([]);
  });
  it('reports changed evidence without claiming or clearing the preview', async () => {
    server.use(http.post('/api/slices/claims/:id/confirm', () => HttpResponse.json({ ok: false,
      error: { category: 'validation', label: 'claim-evidence', message: 'Positions changed; review a new preview.', retryable: true } }, { status: 409 })));
    renderWithClient(<StrategyOwnership />); await fill();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm current ownership' }));
    expect(await screen.findByText(/Positions changed/)).toBeInTheDocument();
    expect(row.status).toBe('preview');
  });
});
