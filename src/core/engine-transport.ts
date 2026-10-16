/** Engine-only signed transport. Selection is explicit; no production enablement here. */
import https from 'node:https';
import axios, { type AxiosInstance, type AxiosProxyConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import type { CrossExApi } from 'gate-api';
import { GATE_HTTP_TIMEOUT_MS, type Clients } from './clients';

export interface EnginePoolOptions { maxSockets: number }
export type WithEngineClient = <T>(fn: (client: CrossExApi) => Promise<T>) => Promise<T>;

/** Match the original explicit GATE_PROXY, else Axios's environment/NO_PROXY choice. */
export function engineProxyRoute(proxy?: AxiosProxyConfig, endpoint = 'https://api.gateio.ws/api/v4'): string | undefined {
  if (!proxy) return getProxyForUrl(endpoint) || undefined;
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.protocol}://${host}:${proxy.port}`;
}

class Session {
  private readonly agent: https.Agent;
  private readonly client: CrossExApi;
  private inFlight = 0;
  private retired = false;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });

  constructor(readonly clients: Clients, readonly route: string | undefined, readonly maxSockets: number) {
    if (new URL(clients.api.basePath).protocol !== 'https:') throw new Error('Engine signed endpoint requires TLS');
    const options = { keepAlive: true, maxSockets, maxTotalSockets: maxSockets,
      maxFreeSockets: maxSockets, scheduling: 'lifo' as const, timeout: 30_000 };
    if (route && !['http:', 'https:'].includes(new URL(route).protocol)) {
      throw new Error('Unsupported engine proxy protocol');
    }
    this.agent = route ? new HttpsProxyAgent(route, options) : new https.Agent(options);
    try {
      if (!clients.engineClient) throw new Error('Engine transport factory unavailable');
      this.client = clients.engineClient(axios.create({
        // Same SDK timeout; coverage of queue/CONNECT/TLS is not an E2E guarantee.
        timeout: GATE_HTTP_TIMEOUT_MS, proxy: false, httpsAgent: this.agent,
        // A signed redirect must not send KEY/SIGN to another origin.
        maxRedirects: 0,
      }));
    } catch (err) { this.agent.destroy(); throw err; }
  }

  async use<T>(fn: (client: CrossExApi) => Promise<T>): Promise<T> {
    if (this.retired) throw new Error('Engine transport retired');
    this.inFlight++;
    try { return await fn(this.client); }
    finally { this.inFlight--; this.release(); }
  }

  retire(): Promise<void> {
    this.retired = true;
    this.release();
    return this.closed;
  }

  private release(): void {
    if (this.retired && this.inFlight === 0) {
      this.agent.destroy();
      this.resolveClosed();
    }
  }

  stats() {
    const count = (entries: Record<string, unknown[] | undefined>) =>
      Object.values(entries).reduce((sum, values) => sum + (values?.length ?? 0), 0);
    return { maxSockets: this.maxSockets, inFlight: this.inFlight, retired: this.retired,
      sockets: count(this.agent.sockets), freeSockets: count(this.agent.freeSockets),
      queued: count(this.agent.requests) };
  }
}

/** Owns only engine sessions, never candidates/UI/Spot/Futures/public clients.
 * One lease spans an entire Venue operation, including create's confirmation.
 * Retired sessions accept no new operations; already leased chains keep their account.
 */
export class EngineTransport {
  private selection: EnginePoolOptions | null = null;
  private current?: Session;
  private readonly draining = new Set<Session>();
  private closed = false;

  constructor(private readonly getClients: () => Clients,
    private readonly getProxy: () => AxiosProxyConfig | undefined = () => undefined) {}

  configure(options: EnginePoolOptions | null): void {
    if (this.closed) throw new Error('Engine transport closed');
    if (options && (!Number.isInteger(options.maxSockets) || options.maxSockets < 1 || options.maxSockets > 16)) {
      throw new Error('Engine pool requires an explicit socket limit from 1 to 16');
    }
    if (this.selection?.maxSockets === options?.maxSockets) return;
    this.invalidate();
    this.selection = options ? { ...options } : null;
  }

  /** Called on validated credential commit; lazy construction means rejected
   * candidates and busy-return paths allocate no dedicated sockets or SDKs. */
  invalidate(): void {
    const old = this.current;
    this.current = undefined;
    if (!old) return;
    const drained = old.retire();
    this.draining.add(old);
    void drained.then(() => this.draining.delete(old));
  }

  async use<T>(fn: (client: CrossExApi) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Engine transport closed');
    const clients = this.getClients();
    if (!this.selection) return fn(clients.crossEx);
    const route = engineProxyRoute(this.getProxy(), clients.api.basePath);
    if (this.current?.clients !== clients || this.current?.route !== route) {
      this.invalidate();
      this.current = new Session(clients, route, this.selection.maxSockets);
    }
    return this.current!.use(fn);
  }

  stats() {
    const sessions = [...this.draining, ...(this.current ? [this.current] : [])].map(session => session.stats());
    const total = (key: 'inFlight' | 'sockets' | 'freeSockets' | 'queued' | 'maxSockets') =>
      sessions.reduce((sum, session) => sum + session[key], 0);
    return { maxSockets: this.current?.maxSockets ?? null, retiringSessions: this.draining.size,
      socketLimitAcrossSessions: total('maxSockets'), inFlight: total('inFlight'),
      sockets: total('sockets'), freeSockets: total('freeSockets'), queued: total('queued') };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.invalidate();
    await Promise.all([...this.draining].map(session => session.closed));
  }
}
