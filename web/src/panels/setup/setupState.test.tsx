import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { qk } from '../../api/queries';
import { installFakeWallet, removeFakeWallet } from '../../test/fakeWallet';
import { agentStatus, credentialsBodies, mockWorld, telegramInfo } from '../../test/fixtures';
import { TrackedAddressProvider } from '../trackedAddress';
import { useSetupState } from './setupState';

const WALLET = `0xab18${'0'.repeat(32)}ed9d`;

function hookWrapper(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TrackedAddressProvider>{children}</TrackedAddressProvider>
    </QueryClientProvider>
  );
  return wrapper;
}

afterEach(removeFakeWallet);

describe('useSetupState', () => {
  it('waits for wallet discovery and the agent-root fallback even when all queries are ready', async () => {
    let finishReading!: (accounts: string[]) => void;
    const accounts = new Promise<string[]>((resolve) => { finishReading = resolve; });
    installFakeWallet({ ethAccounts: () => accounts });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(qk.credentials, credentialsBodies.set);
    client.setQueryData(qk.borosAgent, agentStatus({ configured: true, root: WALLET, expired: false }));
    client.setQueryData(qk.telegram, telegramInfo());
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper(client) });

    expect(result.current.isLoading).toBe(true);
    await act(async () => { finishReading([]); });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('done');
    expect(result.current.doneCount).toBe(2);
  });

  it('an expired approval is not done', async () => {
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET, expired: true }) });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('missing');
    expect(result.current.doneCount).toBe(1);
  });

  it('an expired approval is not done while its wallet is tracked', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: WALLET }));
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET, expired: true }) });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('missing');
    expect(result.current.firstMissing).toBe('borosWallet');
  });

  it('a tracked address with no approval is done', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: WALLET }));
    mockWorld({ keyConfigured: true });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('done');
  });

  it('a live approval is done', async () => {
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET, expired: false }) });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('done');
    expect(result.current.doneCount).toBe(2);
  });

  it('telegram linked to the viewed wallet is done', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: WALLET }));
    mockWorld({ telegram: telegramInfo({ connected: true, state: 'connected', alertWallet: WALLET }) });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.telegram).toBe('done');
  });

  it('telegram linked to another wallet is not done for the viewed one', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: WALLET }));
    mockWorld({ telegram: telegramInfo({ connected: true, state: 'connected', alertWallet: `0x${'1'.repeat(40)}` }) });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.telegram).toBe('missing');
  });
});
