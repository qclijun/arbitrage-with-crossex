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
  ['BINANCE', { code: -1003 }, 300_000], ['BYBIT', { retCode: 10006 }, 60_000], ['OKX', { code: '50011' }, 60_000],
] as const)('stops %s on a business rate-limit error even over HTTP 200', async (venue, data, retryAfterMs) => {
  const read = createOfficialPublicReader({ now: () => now });
  nock('https://public.example').get('/history').reply(200, data);
  await expect(read(venue, 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs });
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

it('stops Bybit access-too-frequent IP bans for at least ten minutes without another wire call', async () => {
  let at = now;
  const read = createOfficialPublicReader({ now: () => at });
  nock('https://public.example').get('/history').reply(403, '403, access too frequent', { 'Retry-After': '1' });
  await expect(read('BYBIT', 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 600_000 });
  at += 599_999;
  await expect(read('BYBIT', 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 1 });
  at += 1;
  nock('https://public.example').get('/history').reply(200, { retCode: 0 });
  expect(await read('BYBIT', 'https://public.example/history', signal())).toEqual({ retCode: 0 });
});

it.each(['BINANCE', 'ASTER'])('keeps an unhinted %s IP ban blocked through the documented maximum duration', async (venue) => {
  let at = now;
  const read = createOfficialPublicReader({ now: () => at });
  const maximumBan = 3 * 86_400_000;
  nock('https://public.example').get('/history').reply(418, { code: -1003 });
  await expect(read(venue, 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: maximumBan });
  at += maximumBan - 1;
  await expect(read(venue, 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 1 });
  at += 1;
  nock('https://public.example').get('/history').reply(200, []);
  expect(await read(venue, 'https://public.example/history', signal())).toEqual([]);
});

it.each([['BINANCE', 418], ['ASTER', 418], ['BINANCE', 429], ['BINANCE', 200]] as const)(
  'honours a future %s ban deadline in a %s response over a shorter header', async (venue, status) => {
    let at = now;
    const read = createOfficialPublicReader({ now: () => at });
    nock('https://public.example').get('/history').reply(status, { code: -1003, msg: `IP banned until ${now + 3_600_000}.` }, { 'Retry-After': '120' });
    await expect(read(venue, 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 3_600_000 });
    at += 3_600_000 - 1;
    await expect(read(venue, 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 1 });
    at += 1;
    nock('https://public.example').get('/history').reply(200, []);
    expect(await read(venue, 'https://public.example/history', signal())).toEqual([]);
  },
);

it('waits a full Binance funding quota period after an unhinted 429 and ignores a stale ban deadline', async () => {
  let at = now;
  const read = createOfficialPublicReader({ now: () => at });
  nock('https://public.example').get('/history').reply(429, { code: -1003, msg: `IP banned until ${now - 1}.` });
  await expect(read('BINANCE', 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 300_000 });
  at += 299_999;
  await expect(read('BINANCE', 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 1 });
  at += 1;
  nock('https://public.example').get('/history').reply(200, []);
  expect(await read('BINANCE', 'https://public.example/history', signal())).toEqual([]);
});

it.each([
  ['BINANCE', '120'], ['ASTER', new Date(now + 120_000).toUTCString()],
] as const)('uses an available %s Retry-After signal instead of the maximum-ban fallback', async (venue, header) => {
  const read = createOfficialPublicReader({ now: () => now });
  nock('https://public.example').get('/history').reply(418, { code: -1003 }, { 'Retry-After': header });
  await expect(read(venue, 'https://public.example/history', signal())).rejects.toMatchObject({ retryAfterMs: 120_000 });
});

it('keeps a Bybit country restriction distinct from an access-too-frequent IP ban', async () => {
  const read = createOfficialPublicReader({ now: () => now });
  nock('https://public.example').get('/history').reply(403, 'The Amazon CloudFront distribution is configured to block access from your country');
  await expect(read('BYBIT', 'https://public.example/history', signal())).rejects.toThrow('official-http-403');
});
