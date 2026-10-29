/**
 * Durable submission identity (ticket 14): the intent is recorded in this
 * browser before it is sent, a lost answer is looked up by that id, and only
 * the server's proof that the preview can never be accepted releases it.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fill, previewAndHold, renderForm, seedSubmission, servePreviews, storedSubmissions } from '../../test/fundingOrderForm';
import { fundingPreview, fundingReceipt } from '../../test/fundingPreview';
import { env, server } from '../../test/server';

afterEach(() => {
  vi.restoreAllMocks();
});

const notFound = (lateAcceptance?: Record<string, unknown>) => HttpResponse.json({
  ok: false, error: { category: 'validation', label: 'intent-unknown', message: 'no intent with this id was accepted by this ledger', retryable: false },
  ...(lateAcceptance ? { lateAcceptance } : {}),
}, { status: 404 });

/** Counts acceptance POSTs; `answer` decides each. */
function serveAccept(answer: (body: any) => Response | Promise<Response>) {
  const bodies: any[] = [];
  server.use(http.post('/api/funding/intents', async ({ request }) => {
    const body = await request.json();
    bodies.push(body);
    return answer(body);
  }));
  return bodies;
}

const stored = storedSubmissions;

describe('durable funding submissions', () => {
  it('records the exact acceptance before sending it', async () => {
    servePreviews(fundingPreview());
    let atSend: unknown = null;
    const posts = serveAccept((body) => {
      atSend = stored();
      return HttpResponse.json(env(fundingReceipt(body.intentId)), { status: 202 });
    });
    server.use(http.get('/api/funding/intents/:id', ({ params }) => HttpResponse.json(env(fundingReceipt(String(params.id))))));
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/Accepted as intent/)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(atSend).toEqual({ [posts[0].intentId]: expect.objectContaining({ candidateId: fundingPreview().content.candidateId, body: posts[0] }) });
  });

  it('refuses to send when this browser cannot durably record the intent', async () => {
    servePreviews(fundingPreview());
    const posts = serveAccept(() => HttpResponse.json(env({}), { status: 202 }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/Not sent: this browser could not record the intent/)).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('a lost answer is looked up by the original id: pending while it may still land, then the receipt', async () => {
    servePreviews(fundingPreview());
    const posts = serveAccept(() => HttpResponse.error());
    const seen: string[] = [];
    let reads = 0;
    server.use(http.get('/api/funding/intents/:id', ({ params, request }) => {
      seen.push(`${params.id}?${new URL(request.url).searchParams.get('previewId')}`);
      reads += 1;
      return reads < 2 ? notFound({ possible: true, until: fundingPreview().expiresAt }) : HttpResponse.json(env(fundingReceipt(String(params.id))));
    }));
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/may still be accepted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(await screen.findByText(/Accepted as intent/, undefined, { timeout: 4_000 })).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(new Set(seen)).toEqual(new Set([`${posts[0].intentId}?p-1`]));
  }, 8_000);

  it('only the server\'s proof that the preview can never land releases the intent', async () => {
    servePreviews(fundingPreview());
    serveAccept(() => HttpResponse.error());
    let reads = 0;
    server.use(http.get('/api/funding/intents/:id', () => {
      reads += 1;
      return reads < 2 ? notFound() : notFound({ possible: false, reason: 'preview-expired' });
    }));
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/no known result yet/)).toBeInTheDocument();
    expect(await screen.findByText(/was not accepted/, undefined, { timeout: 4_000 })).toBeInTheDocument();
    expect(stored()).toEqual({});
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
  }, 8_000);

  it('a definitive refusal releases the intent at once', async () => {
    servePreviews(fundingPreview());
    serveAccept(() => HttpResponse.json({ ok: false, error: { category: 'validation', label: 'active-deal', message: 'an unfinished deal; nothing was created',
      retryable: false } }, { status: 409 }));
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/nothing was created/)).toBeInTheDocument();
    expect(stored()).toEqual({});
  });

  it('a double hold sends one acceptance', async () => {
    servePreviews(fundingPreview());
    let release: () => void = () => {};
    const posts = serveAccept((body) => new Promise<Response>((resolve) => {
      release = () => resolve(HttpResponse.json(env(fundingReceipt(body.intentId)), { status: 202 }));
    }));
    server.use(http.get('/api/funding/intents/:id', ({ params }) => HttpResponse.json(env(fundingReceipt(String(params.id))))));
    renderForm();
    fill();
    await previewAndHold();
    await waitFor(() => expect(posts).toHaveLength(1));
    const hold = screen.queryByRole('button', { name: 'Hold to open' });
    if (hold) {
      fireEvent.pointerDown(hold);
      await new Promise((r) => setTimeout(r, 60));
    }
    release();
    expect(await screen.findByText(/Accepted as intent/)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
  });

  it('an id already in the ledger with other content is looked up, never released', async () => {
    servePreviews(fundingPreview());
    serveAccept(() => HttpResponse.json({ ok: false, error: { category: 'validation', label: 'intent-conflict',
      message: 'intent was already accepted with different content; nothing was changed', retryable: false } }, { status: 409 }));
    server.use(http.get('/api/funding/intents/:id', ({ params }) => HttpResponse.json(env(fundingReceipt(String(params.id))))));
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/Accepted as intent/)).toBeInTheDocument();
    expect(Object.keys(stored())).toHaveLength(1);
  });

  it('another tab\'s intent recorded since this page last looked blocks the send', async () => {
    servePreviews(fundingPreview());
    const posts = serveAccept(() => HttpResponse.json(env({}), { status: 202 }));
    server.use(http.get('/api/funding/intents/:id', () => notFound()));
    renderForm();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    seedSubmission('intent-other-tab', 'other-pair'); // no storage event has reached this page yet
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to open' }));
    expect(await screen.findByText(/Not sent: intent intent-other-tab has no known result yet/)).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
});
