/**
 * Restoring sent funding intents (ticket 14): a reload, an old record, an
 * unreadable store, a failing lookup and several tickets at once all resolve
 * by the recorded id; nothing is resent, nothing new opens while any result
 * is unknown, and a finished deal shows what it really filled.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fill, previewAndHold, renderForm, ROW, seedSubmission, servePreviews, storedSubmissions } from '../../test/fundingOrderForm';
import { fundingPreview, fundingReceipt } from '../../test/fundingPreview';
import { env, server } from '../../test/server';
import { CandidateDetail } from './CandidateDetail';
import { FundingSubmissionsProvider } from './FundingSubmissions';

const CANDIDATE = fundingPreview().content.candidateId;

const seed = (...entries: Array<{ id: string; candidateId?: string; savedAt?: number }>) =>
  entries.forEach(({ id, candidateId = CANDIDATE, savedAt }) => seedSubmission(id, candidateId, savedAt));

/** Answers lookups by id from `deals`, in turn per id (the last repeats); records each lookup. */
function serveLookups(deals: Record<string, Array<Parameters<typeof fundingReceipt>[1] | 'fail'>>) {
  const seen: string[] = [];
  const posts: unknown[] = [];
  server.use(
    http.get('/api/funding/intents/:id', ({ params }) => {
      const id = String(params.id);
      const turn = seen.filter((s) => s === id).length;
      seen.push(id);
      const answers = deals[id];
      const answer = answers[Math.min(turn, answers.length - 1)];
      if (answer === 'fail') return HttpResponse.json({ ok: false, error: { category: 'unknown', message: 'ledger busy', retryable: true } }, { status: 500 });
      return HttpResponse.json(env(fundingReceipt(id, answer)));
    }),
    http.post('/api/funding/intents', () => {
      posts.push(1);
      return HttpResponse.error();
    }),
    http.post('/api/funding/preview', () => {
      posts.push(1);
      return HttpResponse.error();
    }),
  );
  return { seen, posts };
}

const DONE_WITH_DUST = { mode: 'DONE', targetQty: '0.01', aFilled: '0.01', bFilled: '0.009', aUnfilled: '0', filledGap: '0.001',
  report: { reason: 'maker filled; hedge left dust below the minimum order' } } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoring funding submissions', () => {
  it('after a reload a recorded intent, however old, shows its finished receipt with the dust it left; nothing is resent', async () => {
    seed({ id: 'intent-old', savedAt: Date.now() - 6 * 3600_000 });
    const { posts } = serveLookups({ 'intent-old': [DONE_WITH_DUST] });
    renderForm();
    const deal = await screen.findByRole('table', { name: 'Deal' });
    expect(deal).toHaveTextContent('Hedge leg filled0.009');
    expect(screen.getByText(/Finished with 0.001 filled but not hedged/)).toBeInTheDocument();
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByLabelText('Quantity (BTC)')).toBeEnabled();
    expect(storedSubmissions()).toEqual({});
  });

  it('an unreadable record of sent intents blocks new opens and is never overwritten', async () => {
    localStorage.setItem('crossex.fundingSubmission.v1.intent-x', '{not json');
    renderForm();
    expect(screen.getByText(/stored record of a sent intent is unreadable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(localStorage.getItem('crossex.fundingSubmission.v1.intent-x')).toBe('{not json');
  });

  it('a failing lookup says so and keeps blocking, then resolves when the ledger answers', async () => {
    seed({ id: 'intent-a' });
    serveLookups({ 'intent-a': ['fail', { mode: 'OPENING' }] });
    renderForm();
    expect(await screen.findByText(/its result could not be looked up \(ledger busy\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Accepted as intent intent-a/, undefined, { timeout: 4_000 })).toBeInTheDocument();
  }, 8_000);

  it('a part-filled maker whose hedge was rejected shows real fills apart from reservations, and a quarantined order verbatim', async () => {
    seed({ id: 'intent-p' });
    serveLookups({ 'intent-p': [{ mode: 'HALTED', aFilled: '0.004', bFilled: '0', aReserved: '0.01', bReserved: '0.004', aUnfilled: '0.006',
      filledGap: '0.004', haltReason: 'hedge rejected', orders: [
        { clientId: 't-a1', leg: 'A', kind: 'maker', side: 'BUY', qty: '0.01', cumQty: '0.004', state: 'OPEN', closeReason: null,
          quarantinedStatus: 'PARTIALLY_MYSTERIOUS', venueReason: null },
        { clientId: 't-b1', leg: 'B', kind: 'taker', side: 'SELL', qty: '0.004', cumQty: '0', state: 'DEAD', closeReason: 'rejected:BALANCE_NOT_ENOUGH',
          quarantinedStatus: null, venueReason: null },
      ] }] });
    renderForm();
    const deal = await screen.findByRole('table', { name: 'Deal' });
    expect(deal).toHaveTextContent('Hedge leg filled0');
    expect(deal).toHaveTextContent('Filled, not hedged0.004');
    expect(deal).toHaveTextContent('In flight, not filledmaker 0.01 · hedge 0.004');
    const orders = screen.getByRole('table', { name: 'Orders' });
    expect(orders).toHaveTextContent('quarantined: venue status "PARTIALLY_MYSTERIOUS"');
    expect(orders).toHaveTextContent('rejected:BALANCE_NOT_ENOUGH');
    expect(screen.getByText(/Stopping: fills can still land/)).toBeInTheDocument();
  });

  it('a fill landing while the deal stops is shown as it lands, until DONE', async () => {
    seed({ id: 'intent-s' });
    serveLookups({ 'intent-s': [{ mode: 'STOPPING', aFilled: '0.002' }, { mode: 'DONE', aFilled: '0.003', bFilled: '0.003', aUnfilled: '0.007' }] });
    renderForm();
    const deal = await screen.findByRole('table', { name: 'Deal' });
    expect(deal).toHaveTextContent('Maker leg filled0.002');
    await waitFor(() => expect(deal).toHaveTextContent('Maker leg filled0.003'), { timeout: 4_000 });
    expect(screen.getByText(/Finished 0.007 short of the target/)).toBeInTheDocument();
  }, 8_000);

  it('an acceptance with no answer in time is looked up instead of waited on', async () => {
    servePreviews(fundingPreview());
    server.use(
      http.post('/api/funding/intents', () => new Promise<Response>(() => {})),
      http.get('/api/funding/intents/:id', ({ params }) => HttpResponse.json(env(fundingReceipt(String(params.id))))),
    );
    renderForm({ acceptTimeoutMs: 50 });
    fill();
    await previewAndHold();
    expect(await screen.findByText(/Accepted as intent/)).toBeInTheDocument();
  });

  it('opens recorded in the ledger but unknown to this browser are listed by id, claiming nothing', async () => {
    server.use(http.get('/api/funding/intents', ({ request }) => {
      expect(new URL(request.url).searchParams.get('candidateId')).toBe(ROW.id);
      return HttpResponse.json(env([fundingReceipt('intent-elsewhere', DONE_WITH_DUST)]));
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FundingSubmissionsProvider><CandidateDetail row={ROW} days={30} snapshotId="snap-1" admissionOpen /></FundingSubmissionsProvider>
      </QueryClientProvider>,
    );
    const list = await screen.findByRole('list', { name: 'Recorded opens' });
    expect(within(list).getByText(/intent-elsewhere · DONE · maker 0.01 \/ hedge 0.009 of 0.01/)).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity (BTC)')).toBeEnabled();
    expect(screen.queryByText(/no new open/)).not.toBeInTheDocument();
  });

  it('an intent proven never accepted is released once for this page even when the record cannot be removed', async () => {
    seed({ id: 'intent-n' });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    let reads = 0;
    server.use(http.get('/api/funding/intents/:id', () => {
      reads += 1;
      return HttpResponse.json({ ok: false, error: { category: 'validation', label: 'intent-unknown', message: 'no intent', retryable: false },
        lateAcceptance: { possible: false, reason: 'preview-unknown' } }, { status: 404 });
    }));
    renderForm();
    expect(await screen.findByText(/Intent intent-n was not accepted/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 2_500));
    expect(screen.getAllByText(/Intent intent-n was not accepted/)).toHaveLength(1);
    expect(screen.getByText(/could not remove this browser's record of intent intent-n/)).toBeInTheDocument();
    expect(reads).toBe(1);
    expect(screen.getByLabelText('Quantity (BTC)')).toBeEnabled();
  }, 8_000);

  it('a store cleared under an intent with no known result keeps it blocking here and records it again', async () => {
    seed({ id: 'intent-c' });
    server.use(http.get('/api/funding/intents/:id', () => HttpResponse.json({ ok: false,
      error: { category: 'validation', label: 'intent-unknown', message: 'no intent', retryable: false } }, { status: 404 })));
    renderForm({ row: { ...ROW, id: 'another-pair' } });
    expect(await screen.findByText(/Intent intent-c has no known result yet/)).toBeInTheDocument();
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(screen.getByText(/Intent intent-c has no known result yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(Object.keys(storedSubmissions())).toEqual(['intent-c']);
  });
});
