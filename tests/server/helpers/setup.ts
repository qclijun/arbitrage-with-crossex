/**
 * Server-project setup (wired via vitest.config.ts setupFiles): block ALL real
 * network traffic; loopback stays enabled because Fastify's app.inject() is
 * in-process anyway and future tests may drive a listening server.
 * Tests that want "every mock consumed" assert scope.isDone() themselves.
 */
import nock from 'nock';
import { afterAll, afterEach, beforeAll } from 'vitest';

// dotenv loads the repo .env (which may set GATE_PROXY) at clients.ts import time.
// Setting '' here creates the own-property first, so dotenv will not overwrite it —
// otherwise mocked Gate calls would be CONNECT-tunneled to the real local proxy.
process.env.GATE_PROXY = '';

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1|localhost/);
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});
