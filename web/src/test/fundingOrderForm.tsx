/** Shared harness for the opportunity order form tests (ticket 13): render, served previews, and filling the draft. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ComponentProps } from 'react';
import type { FundingPreview } from '../api/fundingIntents';
import { FundingOrderForm } from '../panels/funding/FundingOrderForm';
import { boardRow } from './fundingBoard';
import { env, server } from './server';

export const ROW = boardRow('BTC', 'BINANCE BTCUSDT', 'BYBIT BTCUSDT', 1, '0.438');

export function renderForm(props: Partial<ComponentProps<typeof FundingOrderForm>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FundingOrderForm row={ROW} days={30} snapshotId="snap-1" admissionOpen holdMs={20} {...props} />
    </QueryClientProvider>,
  );
}

/** Answers previews in order (the last one repeats), stamped at their read time, and records every request body. */
export function servePreviews(...answers: FundingPreview[]) {
  const bodies: any[] = [];
  server.use(http.post('/api/funding/preview', async ({ request }) => {
    bodies.push(await request.json());
    const answer = answers[Math.min(bodies.length - 1, answers.length - 1)];
    return HttpResponse.json(env(answer, { ts: answer.readAt }));
  }));
  return bodies;
}

export const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

export function fill() {
  type('Quantity (BTC)', '0.01050');
  fireEvent.click(screen.getByLabelText('Maker: long BYBIT'));
  type('Short leverage', '3');
  type('Long leverage', '5');
  type('Hold days', '14');
}

/** Preview, tick both acknowledgements, and start the hold. */
export async function previewAndHold() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByRole('region', { name: 'Preview' });
  fireEvent.click(screen.getByLabelText(/I authorize converting/));
  fireEvent.click(screen.getByLabelText('I accept the risks listed above.'));
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to open' }));
}
