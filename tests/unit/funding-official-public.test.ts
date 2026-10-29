import nock from 'nock';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOfficialPublicReader, retryAfterMs, type PublicReadSample } from '../../src/core/funding/official-public';

const now = Date.UTC(2026, 9, 30);
const signal = () => new AbortController().signal;
beforeEach(() => nock.disableNetConnect());
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

it('parses seconds and HTTP-date Retry-After without interpreting missing headers as zero', () => {
  expect(retryAfterMs('1.5', now)).toBe(1500);
  expect(retryAfterMs(new Date(now + 120_000).toUTCString(), now)).toBe(120_000);
  expect(retryAfterMs(undefined, now)).toBeNull();
  expect(retryAfterMs('invalid', now)).toBeNull();
});

it.each([
  ['BINANCE', { code: -1003 }], ['BYBIT', { retCode: 10006 }], ['OKX', { code: '50011' }],
])('stops %s on a business rate-limit error even over HTTP 200', async (venue, data) => {
  const read = createOfficialPublicReader({ now: () => now });
  nock('https://public.example').get('/history').reply(200, data);
  await expect(read(venue, 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 60_000 });
});

it('keeps a successful final Bybit response but blocks reads until its quota reset', async () => {
  let at = now;
  const read = createOfficialPublicReader({ now: () => at });
  nock('https://public.example').get('/history').reply(200, { retCode: 0 }, {
    'X-Bapi-Limit-Status': '0', 'X-Bapi-Limit-Reset-Timestamp': String(now + 180_000),
  });
  expect(await read('BYBIT', 'https://public.example/history', signal())).toEqual({ retCode: 0 });
  await expect(read('BYBIT', 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 180_000 });
  at += 180_000;
  nock('https://public.example').get('/history').reply(200, {});
  expect(await read('BYBIT', 'https://public.example/history', signal())).toEqual({});
});

it('reserves HL response weight before requests overlap and never borrows unlimited budget', async () => {
  const read = createOfficialPublicReader({ now: () => now });
  nock('https://public.example').post('/info').times(20).reply(200, []);
  await Promise.all(Array.from({ length: 20 }, () => read('HYPERLIQUID', 'https://public.example/info', signal(), { type: 'fundingHistory' })));
  await expect(read('HYPERLIQUID', 'https://public.example/info', signal(), {})).rejects.toMatchObject({ retryAfterMs: 60_000 });
});

it('uses numeric minute-weight headers against the official declared capacity, separately from funding request quotas', async () => {
  const samples: PublicReadSample[] = [];
  const read = createOfficialPublicReader({ now: () => now, sample: (s) => samples.push(s) });
  nock('https://public.example').get('/exchangeInfo').reply(200, {
    rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 100 }],
  }, { 'X-Mbx-Used-Weight-1m': '95', 'X-Mbx-Used-Weight': '95' });
  await read('ASTER', 'https://public.example/exchangeInfo', signal());
  expect(samples[0].weights).toEqual({ minuteUsed: 95, genericUsed: 95, minuteLimit: 100 });
  await expect(read('ASTER', 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 60_000 });
});
