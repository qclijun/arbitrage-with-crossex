/**
 * Unit-project setup (wired via vitest.config.ts setupFiles). dotenv loads the
 * repo .env (which may set GATE_PROXY) at clients.ts import time. Setting ''
 * here creates the own-property first, so dotenv will not overwrite it —
 * otherwise nock-mocked public reads are CONNECT-tunneled to the real local proxy.
 */
process.env.GATE_PROXY = '';
