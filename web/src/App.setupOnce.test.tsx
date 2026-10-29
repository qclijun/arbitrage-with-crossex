import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import App from './App';
import { qk } from './api/queries';
import type { OpenOrder, TradesResponse, VenueFees } from './api/types';
import { SETUP_SHOWN_KEY } from './panels/setup/setupState';
import {
  agentStatus,
  baseHandlers,
  makeOpportunitiesResult,
  opportunitiesHandler,
  setupHandlers,
  telegramInfo,
} from './test/fixtures';
import { env, server } from './test/server';
import { renderWithClient } from './test/utils';

function mockUpdatedApp() {
  server.use(
    http.get('/api/credentials', () => HttpResponse.json(env({ configured: true, keyMasked: '160e…4f80' }))),
    ...setupHandlers(agentStatus({ configured: true, root: `0xab18${'0'.repeat(32)}ed9d` }), telegramInfo()),
    ...baseHandlers(),
    opportunitiesHandler(makeOpportunitiesResult()),
    http.get('/api/orders/open', () => HttpResponse.json(env<OpenOrder[]>([]))),
    http.get('/api/trades', () =>
      HttpResponse.json(env<TradesResponse>({ trades: [], page: 1, limit: 100, hasMore: false })),
    ),
    http.get('/api/fees', () => HttpResponse.json(env<VenueFees[]>([]))),
    http.get('/api/baskets', () => HttpResponse.json(env([]))),
  );
}

async function renderInitializedApp() {
  const view = renderWithClient(<App />);
  // The auto-open effect waits for these real queries. Flush their completion
  // before asserting the dialog, rather than timing network startup via a DOM
  // query's one-second retry window. The test's normal timeout still applies.
  const settle = async (keys: ReadonlyArray<readonly string[]>) => act(async () => {
    const cache = view.queryClient.getQueryCache();
    const ready = () => keys
      .every((queryKey) => cache.find({ queryKey, exact: true })?.state.status === 'success');
    if (!ready()) await new Promise<void>((resolve) => {
      const unsubscribe = cache.subscribe(() => {
        if (ready()) { unsubscribe(); resolve(); }
      });
    });
    // Query observers publish cache changes on the next timer turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The terminal (and its Telegram observer) mounts after credentials resolve.
  await settle([qk.credentials, qk.borosAgent, qk.disclaimer]);
  await settle([qk.telegram]);
  return view;
}

describe('settings after an update', () => {
  it('opens settings once', async () => {
    mockUpdatedApp();
    await renderInitializedApp();

    const drawer = screen.getByRole('dialog', { name: 'Settings' });
    const row = (name: string) => within(drawer).getByRole('region', { name });
    expect(within(row('Telegram alerts')).getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    expect(within(row('Boros wallet')).getByRole('button', { name: 'Expand' })).toBeInTheDocument();
    expect(localStorage.getItem(SETUP_SHOWN_KEY)).toBe('true');
  });

  it('only once', async () => {
    const user = userEvent.setup();
    mockUpdatedApp();
    const first = await renderInitializedApp();
    const drawer = screen.getByRole('dialog', { name: 'Settings' });
    await user.click(within(drawer).getByRole('button', { name: 'close' }));
    first.unmount();

    await renderInitializedApp();
    expect(await screen.findByRole('button', { name: 'Finish setup 2/3' })).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });
});
