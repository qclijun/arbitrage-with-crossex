import axios, { AxiosError } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVenueBook, fetchVenueBookWithDiagnostics } from '../../src/core/estimate/books';

const adapter = axios.defaults.adapter;
afterEach(() => {
  axios.defaults.adapter = adapter;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('safe public book failure diagnostics', () => {
  it.each([
    ['ECONNABORTED', undefined, 'timeout'],
    ['ETIMEDOUT', undefined, 'timeout'],
    ['ECONNRESET', undefined, 'network'],
    ['ENOTFOUND', undefined, 'network'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', undefined, 'tls'],
    ['ERR_BAD_REQUEST', 429, 'http'],
    ['ERR_BAD_RESPONSE', 503, 'http'],
  ])('classifies %s without retaining private error contents', async (code, status, category) => {
    vi.stubEnv('GATE_PROXY', '');
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(2510);
    axios.defaults.adapter = async (config) => {
      throw new AxiosError('private-proxy-secret', code, config, {}, status ? {
        data: 'private-response-secret', status, statusText: 'private-status', headers: {}, config,
      } : undefined);
    };
    const result = await fetchVenueBookWithDiagnostics('HYPERLIQUID', 'HYPE', 'USDC');
    expect(result).toEqual({ book: null, failure: {
      category, stage: 'book', errorCode: code, httpStatus: status ?? null, elapsedMs: 2500,
    } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(await fetchVenueBook('HYPERLIQUID', 'HYPE', 'USDC')).toBeNull();
  });

  it('records HTTP 200 with invalid metadata and does not fetch the book', async () => {
    const transport = vi.fn(async (config) => ({ data: {}, status: 200, statusText: 'OK', headers: {}, config }));
    axios.defaults.adapter = transport;
    const result = await fetchVenueBookWithDiagnostics('OKX', 'DIAGNOSTIC', 'USDT');
    expect(result.failure).toMatchObject({ category: 'invalid-response', stage: 'metadata', httpStatus: 200 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('records HTTP 200 for an empty book and drops unknown error codes', async () => {
    axios.defaults.adapter = async (config) => ({ data: { levels: [[], []] }, status: 200, statusText: 'OK', headers: {}, config });
    expect((await fetchVenueBookWithDiagnostics('HYPERLIQUID', 'HYPE', 'USDC')).failure)
      .toMatchObject({ category: 'invalid-response', stage: 'book', httpStatus: 200 });
    axios.defaults.adapter = async (config) => { throw new AxiosError('secret', 'secret-code', config); };
    expect((await fetchVenueBookWithDiagnostics('HYPERLIQUID', 'HYPE', 'USDC')).failure)
      .toMatchObject({ category: 'network', errorCode: null, httpStatus: null });
  });

  it('preserves valid normalized books with no failure evidence', async () => {
    axios.defaults.adapter = async (config) => ({ data: { levels: [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]] }, status: 200, statusText: 'OK', headers: {}, config });
    const result = await fetchVenueBookWithDiagnostics('HYPERLIQUID', 'HYPE', 'USDC');
    expect(result.book?.bids).toEqual([[100, 2]]);
    expect(result.failure).toBeNull();
  });
});
