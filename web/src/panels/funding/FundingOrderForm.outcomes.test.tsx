/** What the order form does with each server answer (ticket 13): receipts, refusals, unknown results and UNKNOWN evidence. */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fill, previewAndHold, renderForm, servePreviews } from '../../test/fundingOrderForm';
import { fundingPreview, fundingReceipt } from '../../test/fundingPreview';
import { env, server } from '../../test/server';

afterEach(() => {
  vi.unstubAllGlobals();
});

const refusal = (label: string, message: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ ok: false, error: { category: 'validation', label, message, retryable: false }, ...extra }, { status: 409 });

describe('FundingOrderForm outcomes', () => {
  it('keeps polling a HALTED deal, whose fills can still change, until it is DONE', async () => {
    servePreviews(fundingPreview());
    let reads = 0;
    server.use(
      http.post('/api/funding/intents', async ({ request }) => HttpResponse.json(env(fundingReceipt(((await request.json()) as any).intentId)), { status: 202 })),
      http.get('/api/funding/intents/:id', ({ params }) => {
        reads += 1;
        const halted = reads < 2;
        return HttpResponse.json(env(fundingReceipt(String(params.id), halted
          ? { mode: 'HALTED', aFilled: '0.004', haltReason: 'unknown order state' } : { mode: 'DONE', aFilled: '0.006', bFilled: '0.006' })));
      }),
    );
    renderForm();
    fill();
    await previewAndHold();
    const deal = await screen.findByRole('table', { name: 'Deal' });
    await waitFor(() => expect(deal).toHaveTextContent('HALTED'));
    await waitFor(() => expect(deal).toHaveTextContent('DONE'), { timeout: 6_000 });
    expect(deal).toHaveTextContent('Maker leg filled0.006');
  }, 10_000);

  it('a 5xx acceptance may have been accepted: result unknown, never a refusal', async () => {
    servePreviews(fundingPreview());
    server.use(http.post('/api/funding/intents', () => HttpResponse.json({ ok: false, error: { category: 'unknown', message: 'internal server error',
      retryable: false } }, { status: 500 })));
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/Result unknown for intent/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('a definitive refusal without a new preview returns to the draft, saying why', async () => {
    servePreviews(fundingPreview());
    server.use(http.post('/api/funding/intents', () => refusal('active-deal', 'an unfinished deal started on these contracts meanwhile; nothing was created')));
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/nothing was created/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
  });

  it('a duplicate answer is the original receipt', async () => {
    servePreviews(fundingPreview());
    server.use(
      http.post('/api/funding/intents', async ({ request }) => HttpResponse.json(env({ ...fundingReceipt(((await request.json()) as any).intentId), duplicate: true }))),
      http.get('/api/funding/intents/:id', ({ params }) => HttpResponse.json(env(fundingReceipt(String(params.id))))),
    );
    renderForm();
    fill();
    await previewAndHold();
    expect(await screen.findByText(/Accepted as intent/)).toBeInTheDocument();
  });

  it('a thin book and UNKNOWN amounts block, and show as UNKNOWN rather than a number', async () => {
    const amounts = { normalOneTime: null, conversionOneTime: null, daily: '0.07', normalHold: null, conversionHold: null };
    servePreviews(fundingPreview({ previewId: null, blockers: [{ code: 'depth-insufficient', message: 'BYBIT_FUTURE_BTC_USDT book is too thin for 0.01' }] },
      { amounts, payback: { normal: 'unknown', conversion: 'unknown' } }));
    renderForm();
    fill();
    await previewAndHold();
    const scenarios = screen.getByRole('table', { name: 'Cost scenarios' });
    expect(within(scenarios).getAllByText('UNKNOWN').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('BYBIT_FUTURE_BTC_USDT book is too thin for 0.01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to open' })).toBeDisabled();
  });

  it('a replacement preview counts down from when the refused request was sent, not a fresh 10 s', async () => {
    let clock = 9_000_000;
    servePreviews(fundingPreview());
    const next = fundingPreview({ previewId: 'p-2', readAt: 500_000, expiresAt: 510_000 });
    server.use(http.post('/api/funding/intents', () => {
      clock += 3_000;
      return refusal('preview-changed', 'what you confirmed has changed', { preview: next });
    }));
    renderForm({ now: () => clock });
    fill();
    await previewAndHold();
    expect(await screen.findByText(/Valid for 7 s/)).toBeInTheDocument();
  });

  it('confirms without crypto.randomUUID (a non-secure origin) using the shared id helper', async () => {
    vi.stubGlobal('crypto', {});
    servePreviews(fundingPreview());
    const ids: string[] = [];
    server.use(http.post('/api/funding/intents', async ({ request }) => {
      const body = (await request.json()) as any;
      ids.push(body.intentId);
      return HttpResponse.json(env(fundingReceipt(body.intentId)), { status: 202 });
    }), http.get('/api/funding/intents/:id', ({ params }) => HttpResponse.json(env(fundingReceipt(String(params.id))))));
    renderForm();
    fill();
    await previewAndHold();
    await waitFor(() => expect(ids).toHaveLength(1));
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports an acceptance upward and, given one, shows its receipt instead of a new draft', async () => {
    servePreviews(fundingPreview());
    server.use(
      http.post('/api/funding/intents', async ({ request }) => HttpResponse.json(env(fundingReceipt(((await request.json()) as any).intentId)), { status: 202 })),
      http.get('/api/funding/intents/:id', ({ params }) => HttpResponse.json(env(fundingReceipt(String(params.id))))),
    );
    const onAccepted = vi.fn();
    const { unmount } = renderForm({ onAccepted });
    fill();
    await previewAndHold();
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    unmount();
    renderForm({ accepted: onAccepted.mock.calls[0][0] });
    expect(screen.getByText(/Accepted as intent/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });
});
