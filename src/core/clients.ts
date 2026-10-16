import 'dotenv/config';
import axios, { type AxiosInstance, type AxiosProxyConfig } from 'axios';
import { ApiClient, CrossExApi, FuturesApi, SpotApi } from 'gate-api';
import { CoreError } from './errors';

/** Axios timeout on every Gate call; queue/CONNECT/TLS coverage is not a proven
 * end-to-end deadline. The SDK's default axios instance has
 * NO timeout — one hung request would stall the reconcile loop (and with it
 * every deal's convergence, e.g. a pending Stop) indefinitely. A timed-out call
 * surfaces as a network error → the engine's UNKNOWN/error paths, which are
 * safe by design (probe-and-resolve, never guess). */
export const GATE_HTTP_TIMEOUT_MS = 15_000;

/** Gate Broker Program channel id, sent as X-Gate-Channel-Id on every signed
 * request so Gate can attribute this tool's order flow (the same mechanism
 * CCXT and Hummingbot use). Inert until Gate registers the id to us —
 * unregistered values are ignored server-side. */
const GATE_CHANNEL_ID = 'boros';

export interface Clients {
  api: ApiClient;
  crossEx: CrossExApi;
  spot: SpotApi;
  futures: FuturesApi;
  /** Lazy engine-only SDK factory; never used by credential validation. */
  engineClient?: (http: AxiosInstance) => CrossExApi;
}

export interface Credentials {
  key: string;
  secret: string;
}

/**
 * Optional HTTP(S) proxy for Gate API calls and public venue books —
 * `.env`: `GATE_PROXY=http://127.0.0.1:7899`.
 * Scoped per axios instance/request (never process-wide); Boros keeps its own
 * transport. Axios CONNECT-tunnels HTTPS targets through it, so signed TLS stays
 * end-to-end and the proxy only sees the destination host.
 */
export function gateProxy(): AxiosProxyConfig | undefined {
  const raw = process.env.GATE_PROXY?.trim();
  if (!raw) return undefined;
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  return {
    protocol: u.protocol.replace(/:$/, ''),
    host: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
  };
}

/**
 * Build an authenticated official `gate-api` ApiClient and the typed API objects.
 * The official SDK (v7.2+) ships a native `CrossExApi`; we use it directly.
 * Credentials default to `.env` (GATE_API_KEY / GATE_API_SECRET); pass `creds`
 * to build a client for other keys (the server's hot-swap + candidate validation).
 */
export function makeClients(creds?: Credentials): Clients {
  const key = creds?.key ?? process.env.GATE_API_KEY;
  const secret = creds?.secret ?? process.env.GATE_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      'Missing GATE_API_KEY / GATE_API_SECRET. Add them to a .env file in the project root.',
    );
  }
  const signedApi = (http: AxiosInstance): ApiClient => {
    const api = new ApiClient(undefined, http);
    api.setApiKeySecret(key, secret);
    // Mutate rather than replace the stock decimal header.
    api.defaultHeaders['X-Gate-Channel-Id'] = GATE_CHANNEL_ID;
    return api;
  };
  const api = signedApi(axios.create({ timeout: GATE_HTTP_TIMEOUT_MS, proxy: gateProxy() }));
  return {
    api,
    engineClient: http => {
      const engineApi = signedApi(http);
      engineApi.basePath = api.basePath;
      return new CrossExApi(engineApi);
    },
    crossEx: new CrossExApi(api),
    spot: new SpotApi(api),
    futures: new FuturesApi(api),
  };
}

/**
 * Server-boot variant: null when no credentials are configured yet, so the app
 * can start and serve the first-run credentials UI. Other callers keep using
 * `makeClients` and its hard throw.
 */
export function makeClientsIfConfigured(): Clients | null {
  if (!process.env.GATE_API_KEY || !process.env.GATE_API_SECRET) return null;
  return makeClients();
}

/**
 * Unsigned CrossEx client for the endpoints Gate serves PUBLICLY — the SDK
 * declares `authSettings = []` for `/crossex/rule/symbols` and
 * `/crossex/rule/risk_limits`, and both answer an unsigned request. That is the
 * whole tradable universe plus every symbol's leverage cap, so the market view
 * never has to gate them behind credentials (only `/crossex/fee` and the
 * account/order endpoints are genuinely per-user).
 *
 * Memoized: one ApiClient, same base path and interceptors as the signed one.
 */
let publicClient: CrossExApi | undefined;
export function publicCrossEx(): CrossExApi {
  publicClient ??= new CrossExApi(new ApiClient(undefined, axios.create({ timeout: GATE_HTTP_TIMEOUT_MS, proxy: gateProxy() })));
  return publicClient;
}

/** Gate for routes that need a live client while the server may be unconfigured. */
export function requireClients(clients: Clients | null): Clients {
  if (!clients) {
    throw new CoreError(
      'Gate API credentials are not configured — enter them in the setup guide in the web app.',
      'not-configured',
    );
  }
  return clients;
}
