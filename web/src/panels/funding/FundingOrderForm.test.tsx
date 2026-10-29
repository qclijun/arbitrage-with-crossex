import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { boardRow } from '../../test/fundingBoard';
import { fill, renderForm, ROW, seedSubmission, servePreviews, type } from '../../test/fundingOrderForm';
import { fundingPreview, fundingReceipt } from '../../test/fundingPreview';
import { env, server } from '../../test/server';
import { FundingOrderForm } from './FundingOrderForm';
import { FundingSubmissionsProvider } from './FundingSubmissions';

describe('FundingOrderForm', () => {
  it('prefills the exact two legs and previews the typed decimals unchanged; nothing is chosen for the user', async () => {
    const bodies = servePreviews(fundingPreview());
    renderForm();
    const preview = screen.getByRole('button', { name: 'Preview' });
    expect(preview).toBeDisabled();
    expect(screen.getByLabelText('Maker: short BINANCE')).not.toBeChecked();
    expect(screen.getByLabelText('Maker: long BYBIT')).not.toBeChecked();
    expect(screen.getByLabelText('Short leverage')).toHaveValue('');
    expect(screen.getByLabelText('Maker timeout (s)')).toHaveValue('300');
    fill();
    fireEvent.click(preview);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      underlying: 'BTC', snapshotId: 'snap-1', windowDays: 30,
      short: { venue: 'BINANCE', contractId: 'BTCUSDT', symbol: 'BINANCE_FUTURE_BTC_USDT' },
      long: { venue: 'BYBIT', contractId: 'BTCUSDT', symbol: 'BYBIT_FUTURE_BTC_USDT' },
      quantity: '0.01050', makerLeg: 'long', leverage: { short: '3', long: '5' }, makerPrice: null, timeoutSec: 300, holdDays: '14',
    });
    const summary = await screen.findByRole('region', { name: 'Preview' });
    expect(summary).toHaveTextContent('You typed 0.01050 BTC');
    expect(summary).toHaveTextContent('Final quantity 0.01 BTC');
    expect(summary).toHaveTextContent('rounded down to the common lot step 0.001');
    const legs = within(summary).getByRole('table', { name: 'Legs' });
    expect(legs).toHaveTextContent('BINANCE_FUTURE_BTC_USDT');
    expect(legs).toHaveTextContent('SELL');
    expect(legs).toHaveTextContent('hedge');
    expect(legs).toHaveTextContent('3x');
    expect(legs).toHaveTextContent('BUY');
    expect(legs).toHaveTextContent('maker');
  });

  it('keeps a same-venue sibling contract exactly, and refuses a quantity it cannot send as typed', async () => {
    const bodies = servePreviews(fundingPreview());
    const usdc = boardRow('BTC', 'BINANCE BTCUSDC', 'BYBIT BTCUSDT', 2, '0.2', {
      short: { venue: 'BINANCE', contractId: 'BTCUSDC', symbol: 'BINANCE_FUTURE_BTC_USDC' } });
    renderForm({ row: usdc });
    fill();
    for (const bad of ['0', '0.0000000000001', '1e-3', '-1', '1,5']) {
      type('Quantity (BTC)', bad);
      expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    }
    type('Quantity (BTC)', '0.000000000001');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ quantity: '0.000000000001',
      short: { venue: 'BINANCE', contractId: 'BTCUSDC', symbol: 'BINANCE_FUTURE_BTC_USDC' } });
  });

  it('refuses an out-of-range or fractional timeout rather than clamping it, and sends nothing', async () => {
    const bodies = servePreviews(fundingPreview());
    renderForm();
    fill();
    for (const bad of ['20', '3601', '45.5', '']) {
      type('Maker timeout (s)', bad);
      expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    }
    type('Maker timeout (s)', '3600');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].timeoutSec).toBe(3600);
  });

  it('shows both cost scenarios and requires the conversion authorization and the risks before the hold', async () => {
    servePreviews(fundingPreview());
    const accepted: any[] = [];
    server.use(
      http.post('/api/funding/intents', async ({ request }) => {
        const body = (await request.json()) as any;
        accepted.push(body);
        return HttpResponse.json(env(fundingReceipt(body.intentId)), { status: 202 });
      }),
      http.get('/api/funding/intents/:id', ({ params }) => HttpResponse.json(env(fundingReceipt(String(params.id),
        { mode: 'DONE', aFilled: '0.008', bFilled: '0.008', unhedged: '0', report: { reason: 'maker timeout; remainder converted' } })))),
    );
    renderForm();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const scenarios = await screen.findByRole('table', { name: 'Cost scenarios' });
    expect(scenarios).toHaveTextContent('Maker fills, hedge taker-0.42 USDT0.56 USDT6.0 d');
    expect(scenarios).toHaveTextContent('Maker remainder converts to taker-0.63 USDT0.35 USDT9.0 d');
    expect(screen.getByText(/no price or total-cost cap/)).toBeInTheDocument();
    const hold = screen.getByRole('button', { name: 'Hold to open' });
    expect(hold).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I authorize converting the unfilled maker remainder to taker after 300 s/));
    expect(hold).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    expect(hold).toBeEnabled();
    fireEvent.pointerDown(hold);
    await screen.findByRole('status');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toEqual({ intentId: expect.stringMatching(/^[0-9a-f-]{36}$/), previewId: 'p-1', contentHash: 'h'.repeat(64),
      authorizeConversion: true, acknowledgeRisks: true });
    expect(screen.getByRole('status')).toHaveTextContent(`Accepted as intent ${accepted[0].intentId}`);
    // The receipt is the deal's real state: actual fills per leg, not the target.
    const receipt = await screen.findByRole('table', { name: 'Deal' });
    await waitFor(() => expect(receipt).toHaveTextContent('DONE'));
    expect(receipt).toHaveTextContent('Target0.01');
    expect(receipt).toHaveTextContent('Maker leg filled0.008');
    expect(receipt).toHaveTextContent('Hedge leg filled0.008');
    expect(receipt).toHaveTextContent('maker timeout; remainder converted');
    expect(screen.getByText(/DONE is not proof of a full fill/)).toBeInTheDocument();
  });

  it('any edit drops the preview and its acknowledgements, and aborts a hold in progress', async () => {
    const bodies = servePreviews(fundingPreview());
    let accepted = 0;
    server.use(http.post('/api/funding/intents', () => {
      accepted += 1;
      return HttpResponse.json(env(fundingReceipt('x')), { status: 202 });
    }));
    renderForm({ holdMs: 400 });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to open' }));
    type('Long leverage', '6');
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(accepted).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    expect(bodies.at(-1).leverage).toEqual({ short: '3', long: '6' });
    expect(screen.getByLabelText(/I authorize converting/)).not.toBeChecked();
    expect(screen.getByLabelText('I accept the risks listed above.')).not.toBeChecked();
  });

  it('expires on the server\'s clock and cannot be held after', async () => {
    let clock = 5_000_000;
    // The server says 2 s have already passed since the read: 8 s remain.
    servePreviews(fundingPreview({ readAt: 100_000, expiresAt: 110_000 }));
    server.use(http.post('/api/funding/preview', () => HttpResponse.json(env(fundingPreview({ readAt: 100_000, expiresAt: 110_000 }), { ts: 102_000 }))));
    renderForm({ now: () => clock });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    expect(await screen.findByText(/Valid for 8 s/)).toBeInTheDocument();
    clock += 8_000;
    expect(await screen.findByText(/Preview expired/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold to open' })).toBeDisabled();
  });

  it('a hold that completes after the deadline sends nothing, even before the countdown catches up', async () => {
    let clock = 5_000_000;
    servePreviews(fundingPreview());
    let posts = 0;
    server.use(http.post('/api/funding/intents', () => {
      posts += 1;
      return HttpResponse.json(env(fundingReceipt('x')), { status: 202 });
    }));
    renderForm({ now: () => clock });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    clock += 10_000;
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to open' }));
    expect(await screen.findByText(/Preview expired/)).toBeInTheDocument();
    expect(posts).toBe(0);
  });

  it('a refusal with a new preview replaces it and clears the confirmation', async () => {
    servePreviews(fundingPreview());
    const next = fundingPreview({ previewId: 'p-2', contentHash: 'n'.repeat(64) }, { makerPrice: '60001.5' });
    server.use(http.post('/api/funding/intents', () => HttpResponse.json({ ok: false, error: { category: 'validation', label: 'preview-changed',
      message: 'what you confirmed has changed', retryable: true }, preview: next }, { status: 409 })));
    renderForm();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to open' }));
    expect(await screen.findByText(/what you confirmed has changed — confirm the new preview/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent('Maker price 60001.5');
    expect(screen.getByLabelText(/I authorize converting/)).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Hold to open' })).toBeDisabled();
  });

  it('blockers and a closed admission cannot be ticked away', async () => {
    servePreviews(fundingPreview({ previewId: null, blockers: [{ code: 'fees-unknown', message: 'BYBIT_FUTURE_BTC_USDT account fee rate is unknown' }] }));
    renderForm({ admissionOpen: false });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('BYBIT_FUTURE_BTC_USDT account fee rate is unknown')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    expect(screen.getByRole('button', { name: 'Hold to open' })).toBeDisabled();
    expect(screen.getByText(/Manual opening is not enabled/)).toBeInTheDocument();
  });

  it('with admission closed even an acceptable-looking preview cannot be held', async () => {
    servePreviews(fundingPreview());
    renderForm({ admissionOpen: false });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    expect(screen.getByRole('button', { name: 'Hold to open' })).toBeDisabled();
  });

  it('a zero or negative history or scenario is highlighted but may still be confirmed', async () => {
    servePreviews(fundingPreview({}, { warnings: ['scenario-not-positive', 'leverage-change:BYBIT_FUTURE_BTC_USDT:10->5'] }));
    renderForm({ row: boardRow('BTC', 'BINANCE BTCUSDT', 'BYBIT BTCUSDT', 9, '-0.1') });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/The 30d historical spread is zero or negative/)).toBeInTheDocument();
    expect(screen.getByText(/This scenario is not positive/)).toBeInTheDocument();
    expect(screen.getByText('Leverage on BYBIT_FUTURE_BTC_USDT changes from 10x to 5x before any order.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    expect(screen.getByRole('button', { name: 'Hold to open' })).toBeEnabled();
  });

  it('a lost acceptance has no known result: nothing is retried, it is looked up by its id instead', async () => {
    servePreviews(fundingPreview());
    let posts = 0;
    const lookups: string[] = [];
    server.use(http.post('/api/funding/intents', () => {
      posts += 1;
      return HttpResponse.error();
    }), http.get('/api/funding/intents/:id', ({ params }) => {
      lookups.push(String(params.id));
      return HttpResponse.json({ ok: false, error: { category: 'validation', label: 'intent-unknown', message: 'no intent', retryable: false },
        lateAcceptance: { possible: true, until: fundingPreview().expiresAt } }, { status: 404 });
    }));
    renderForm();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    fireEvent.click(screen.getByLabelText(/I authorize converting/));
    fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to open' }));
    expect(await screen.findByText(/no known result yet/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(posts).toBe(1);
    expect(lookups[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('another pair\'s intent with no known result blocks a new open here too', async () => {
    seedSubmission('intent-elsewhere', 'other-pair');
    server.use(http.get('/api/funding/intents/:id', () => HttpResponse.json({ ok: false,
      error: { category: 'validation', label: 'intent-unknown', message: 'no intent', retryable: false } }, { status: 404 })));
    renderForm();
    expect(await screen.findByText(/Intent intent-elsewhere has no known result yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('a new history snapshot drops the preview but keeps what was typed', async () => {
    const bodies = servePreviews(fundingPreview());
    const client = new QueryClient();
    const ui = (snapshotId: string) => (
      <QueryClientProvider client={client}>
        <FundingSubmissionsProvider><FundingOrderForm row={ROW} days={30} snapshotId={snapshotId} admissionOpen holdMs={20} /></FundingSubmissionsProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(ui('snap-1'));
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('region', { name: 'Preview' });
    rerender(ui('snap-2'));
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Quantity (BTC)')).toHaveValue('0.01050');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].snapshotId).toBe('snap-2');
  });

  it('a leg without a proven CrossEx symbol offers no form at all', () => {
    renderForm({ row: boardRow('BTC', 'BINANCE BTCUSDC', 'BYBIT BTCUSDT', 2, '0.2', {
      short: { venue: 'BINANCE', contractId: 'BTCUSDC', symbol: null } }) });
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByText(/no proven CrossEx symbol/)).toBeInTheDocument();
  });
});
