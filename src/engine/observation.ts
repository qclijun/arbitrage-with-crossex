/** Best-effort local evidence. Never awaited by the trading loop. */
import { hash, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

export interface ObservationFields {
  leg?: 'A' | 'B';
  client?: string;
  order?: string | null;
  fill?: string;
  contract?: string;
  quantity?: string;
  cumulative?: string;
  aFilled?: string;
  bFilled?: string;
  aReserved?: string;
  bReserved?: string;
  unreserved?: string;
  outcome?: 'ok' | 'reject' | 'unknown' | 'notFound';
  operation?: string;
  mode?: string;
  policy?: string;
  price?: string | null;
  action?: string;
  reason?: string;
  cacheKey?: string;
  cacheHit?: boolean;
  cacheWrittenUtcMs?: number;
  receivedUtcMs?: number;
  cacheResidenceMs?: number;
  startedMonoMs?: number;
  httpStatus?: number;
  errorCategory?: 'rate-limit' | 'http' | 'transport';
}
export interface ObservationContext { observer: EngineObservation; tick: number; deal: string; dealTag?: string }
interface PendingRecord {
  deal: string; tick: number; stage: string; fields: ObservationFields & { reasonCode?: string };
  seq: number; monoMs: number; utcMs: number; cost: number;
}
interface WriterCounts { dropped: number; writeFailures: number; rotations: number; rotationFailures: number }
const MiB = 1024 * 1024;
const DAY = 86_400_000;
const WRITE_DEADLINE_MS = 5000;
const stages = new Set(['tick-start', 'tick-end', 'fill-confirmed', 'registered', 'send-entry', 'receipt',
  'intent', 'intent-changed', 'projection', 'decision', 'cache', 'order-linked']);
const fieldKeys = ['client', 'order', 'fill', 'cacheKey', 'reason', 'contract',
  'quantity', 'cumulative', 'aFilled', 'bFilled', 'aReserved', 'bReserved', 'unreserved', 'price',
  'leg', 'outcome', 'operation', 'mode', 'policy', 'action', 'errorCategory',
  'cacheHit', 'cacheWrittenUtcMs', 'receivedUtcMs', 'cacheResidenceMs', 'startedMonoMs', 'httpStatus'] as const;

const reasonCodes: ReadonlyArray<readonly [string, string]> = [
  ['frozen: order in doubt', 'order-in-doubt'], ['frozen: unclassifiable venue status', 'quarantined-status'],
  ['waiting for orders to settle', 'orders-unsettled'], ['cannot verify residual hedgeability', 'hedgeability-unknown'],
  ['unhedged residual still hedgeable', 'hedge-owed'], ['maker canceled on venue', 'venue-stop'],
  ['maker timeout', 'maker-timeout'], ['persistent hedge wall', 'hedge-wall'], ['halted', 'operator-required'],
  ['A-leg failing repeatedly', 'acquire-wall'], ['convert paused', 'hedge-first'], ['clip backoff', 'clip-backoff'],
  ['clip deferred', 'clip-price-unavailable'], ['acquisition paused: hedge owed', 'hedge-price-unavailable'],
  ['acquisition paused: hedge failed', 'hedge-backoff'], ['book unavailable', 'maker-book-unavailable'],
  ['maker resting', 'maker-resting'], ['post-only quote rejected', 'post-only-budget'],
  ['the limit price kept crossing', 'maker-reject-budget'], ['maker backoff', 'maker-backoff'],
  ['no price available', 'price-unavailable'], ['intent changed mid-tick', 'intent-changed'], ['done', 'done'],
];

export class EngineObservation {
  private readonly salt = randomBytes(32).toString('hex') + ':';
  private readonly ids = new Map<string, { tag: string; cost: number }>();
  private idBytes = 0;
  private readonly idLimit: number;
  readonly run = randomBytes(12).toString('hex');
  private tick = 0;
  private seq = 0;
  private queue: PendingRecord[] = [];
  private readonly free: PendingRecord[] = [];
  private buffered = 0; // Pending + in-flight primitives AND encoded representation.
  private task?: Promise<void>;
  private scheduled = false;
  private closed = false;
  private failed = false;
  private statusDirty = true;
  private lastAlert = -Infinity;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly worker?: Worker;
  private pending?: { resolve: (counts: WriterCounts) => void; reject: () => void };
  private counts: WriterCounts = { dropped: 0, writeFailures: 0, rotations: 0, rotationFailures: 0 };

  constructor(directory: string, private readonly alert: (message: string) => void,
    private readonly limits = { bufferBytes: MiB, detailBytes: 100 * MiB, detailAgeMs: 7 * DAY }) {
    if (!Number.isSafeInteger(limits.bufferBytes) || limits.bufferBytes < 1 || limits.bufferBytes > MiB ||
      !Number.isSafeInteger(limits.detailBytes) || limits.detailBytes < 1 || limits.detailBytes > 100 * MiB ||
      !Number.isSafeInteger(limits.detailAgeMs) || limits.detailAgeMs < 1 || limits.detailAgeMs > 7 * DAY) {
      throw new Error('observation limits must be positive and within the resource contract');
    }
    this.idLimit = Math.min(64 * 1024, Math.floor(limits.bufferBytes / 16));
    try {
      const worker = new Worker(new URL('./observation-writer.cjs', import.meta.url), {
        workerData: { directory, limits, run: this.run },
        execArgv: [], // No inherited tsx/test/profiling loaders in the plain CJS writer.
        // Isolate allocation/GC from SQLite and bound the new isolate's heap.
        resourceLimits: { maxOldGenerationSizeMb: 7, maxYoungGenerationSizeMb: 1, stackSizeMb: 0.5 },
      });
      this.worker = worker;
      worker.on('message', (counts: WriterCounts) => {
        const pending = this.pending;
        this.pending = undefined;
        worker.unref();
        pending?.resolve(counts);
      });
      const failure = () => {
        if (this.failed || this.closed && !this.pending) return;
        this.failed = true;
        this.counts.dropped += this.queue.length;
        this.buffered -= this.queue.reduce((sum, entry) => sum + entry.cost, 0);
        this.queue = [];
        if (this.pending) { this.pending.reject(); this.pending = undefined; }
        else { this.counts.writeFailures++; this.warn(); }
      };
      worker.on('error', failure);
      worker.on('exit', failure);
      worker.unref();
    } catch { this.failed = true; this.counts.writeFailures++; this.warn(); }
    this.timer = setInterval(() => { this.statusDirty = true; this.schedule(); }, 60_000);
    this.timer.unref();
    this.schedule();
  }

  private id(value: string): string {
    const hit = this.ids.get(value);
    if (hit) return hit.tag;
    const tag = hash('sha256', this.salt + value, 'base64url');
    const cost = (value.length + tag.length) * 2 + 96;
    if (cost <= this.idLimit) {
      while (this.idBytes + cost > this.idLimit) {
        const oldest = this.ids.entries().next().value!;
        this.idBytes -= oldest[1].cost;
        this.ids.delete(oldest[0]);
      }
      this.ids.set(value, { tag, cost }); this.idBytes += cost;
    }
    return tag;
  }

  stats() { return { ...this.counts, bufferedBytes: this.buffered, idCacheBytes: this.idBytes, evidence: this.counts.dropped || this.counts.writeFailures || this.counts.rotationFailures ? 'UNKNOWN' : 'COMPLETE' }; }

  async tickPair<T>(deal: string, fn: (ctx: ObservationContext) => Promise<T>): Promise<T> {
    const ctx = { observer: this, tick: ++this.tick, deal };
    this.record(ctx, 'tick-start');
    let outcome: 'ok' | 'unknown' = 'unknown';
    try { const result = await fn(ctx); outcome = 'ok'; return result; }
    finally { this.record(ctx, 'tick-end', { outcome }); }
  }

  record(ctx: ObservationContext, stage: string, fields: ObservationFields = {}): void {
    try {
      if (this.closed || ctx.observer !== this) return;
      if (!stages.has(stage)) { this.counts.dropped++; this.statusDirty = true; this.warn(); return; }
      const seq = ++this.seq;
      const monoMs = performance.now(), utcMs = Date.now();
      let cost = 2048 + ctx.deal.length * 2;
      for (const key of fieldKeys) {
        const value = fields[key];
        if (typeof value === 'string') cost += value.length * 8 + 32;
        else if (value === null || typeof value === 'number' || typeof value === 'boolean') cost += 32;
      }
      if (this.failed || this.buffered + cost > this.limits.bufferBytes - this.idLimit) {
        this.counts.dropped++; this.statusDirty = true; this.warn(); this.schedule(); return;
      }
      const entry = this.free.pop() ?? { deal: '', tick: 0, stage: '', fields: {}, seq: 0, monoMs: 0, utcMs: 0, cost: 0 };
      entry.deal = ctx.dealTag ?? (ctx.dealTag = this.id(ctx.deal)); entry.tick = ctx.tick; entry.stage = stage; entry.seq = seq;
      entry.monoMs = monoMs; entry.utcMs = utcMs; entry.cost = cost;
      for (const key of fieldKeys) {
        const value = fields[key];
        if (typeof value === 'string' && (key === 'client' || key === 'order' || key === 'fill' || key === 'cacheKey' || key === 'reason')) {
          (entry.fields as Record<string, unknown>)[key] = this.id(value);
        } else if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          (entry.fields as Record<string, unknown>)[key] = value;
        }
      }
      if (fields.reason) entry.fields.reasonCode = reasonCodes.find(([prefix]) => fields.reason!.startsWith(prefix))?.[1] ??
        (['idle', 'setMode', 'place', 'cancel', 'finish'].includes(fields.action ?? '') ? fields.action : 'UNKNOWN');
      this.queue.push(entry);
      this.buffered += cost;
      this.schedule();
    } catch { this.counts.dropped++; this.statusDirty = true; this.warn(); }
  }

  private warn(): void {
    if (performance.now() - this.lastAlert < 60_000) return;
    this.lastAlert = performance.now();
    setImmediate(() => {
      try { this.alert('Engine observation evidence UNKNOWN: records dropped or storage failed; inspect observation counters.'); }
      catch { /* diagnostics must never break trading */ }
    });
  }

  private schedule(): void {
    if (this.scheduled || this.task || this.closed || this.failed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.closed) void this.flush(false);
    });
  }

  /** Explicit drain for tests/shutdown; never awaited by the trading loop. */
  async flush(forceStatus = true): Promise<void> {
    if (this.task) { await this.task; if (this.queue.length || this.statusDirty && !this.failed) await this.flush(forceStatus); return; }
    const records = this.queue;
    this.queue = [];
    const reserved = records.reduce((sum, entry) => sum + entry.cost, 0);
    const batchCount = records.length;
    if (this.failed) { this.buffered -= reserved; this.counts.dropped += batchCount; return; }
    this.statusDirty = false;
    this.task = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const reply = await new Promise<WriterCounts>((resolve, reject) => {
          deadline = setTimeout(() => this.pending?.reject(), WRITE_DEADLINE_MS);
          deadline.unref();
          this.pending = { resolve, reject: () => reject(new Error('observation worker unavailable')) };
          this.worker!.ref();
          this.worker!.postMessage({ records, stats: { ...this.stats(), bufferedBytes: this.buffered - reserved }, seq: this.seq, forceStatus });
          // The bounded pool reuses frame objects without keeping identifiers alive.
          for (const entry of records) {
            entry.deal = '';
            delete entry.fields.reasonCode;
            for (const key of fieldKeys) delete (entry.fields as Record<string, unknown>)[key];
            this.free.push(entry);
          }
          records.length = 0;
        });
        this.counts.dropped += reply.dropped;
        this.counts.writeFailures += reply.writeFailures;
        this.counts.rotations += reply.rotations;
        this.counts.rotationFailures += reply.rotationFailures;
        if (reply.dropped || reply.writeFailures || reply.rotationFailures) this.warn();
      } catch {
        this.failed = true; this.pending = undefined; this.worker?.unref();
        this.counts.writeFailures++; this.counts.dropped += batchCount + this.queue.length;
        this.buffered -= this.queue.reduce((sum, entry) => sum + entry.cost, 0);
        this.queue = [];
        void this.worker?.terminate().catch(() => undefined);
        this.warn();
      } finally { if (deadline) clearTimeout(deadline); this.buffered -= reserved; }
    })();
    await this.task;
    this.task = undefined;
    if (this.queue.length || this.statusDirty) this.schedule();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.closed = true;
    await this.flush();
    await this.worker?.terminate();
    this.free.length = 0;
    this.ids.clear(); this.idBytes = 0;
  }
}

export function recordObservation(ctx: ObservationContext | undefined, stage: string, fields?: ObservationFields): void {
  ctx?.observer.record(ctx, stage, fields);
}

function errorFields(error: unknown): ObservationFields {
  try {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      return { httpStatus: status, errorCategory: status === 429 ? 'rate-limit' : 'http' };
    }
  } catch { /* never inspect or serialize exception text */ }
  return { errorCategory: 'transport' };
}

/** Local application entry and completion, NOT NIC/network-send timestamps. */
export function observeCall<T>(ctx: ObservationContext | undefined, operation: string, fields: ObservationFields, fn: () => Promise<T>): Promise<T> {
  if (!ctx) return fn();
  const startedMonoMs = performance.now();
  recordObservation(ctx, 'send-entry', { ...fields, operation, startedMonoMs });
  let request: Promise<T>;
  try { request = fn(); }
  catch (err) { recordObservation(ctx, 'receipt', { ...fields, operation, startedMonoMs, outcome: 'unknown', ...errorFields(err) }); throw err; }
  return request.then(result => {
    const kind = (result as { kind?: string } | null)?.kind;
    const outcome = kind === 'reject' ? 'reject' : kind === 'unknown' || kind === 'error' || result === null || (result as { covered?: boolean } | null)?.covered === false
      ? 'unknown' : kind === 'notFound' ? 'notFound' : 'ok';
    recordObservation(ctx, 'receipt', { ...fields, operation, startedMonoMs, outcome });
    return result;
  }, err => {
    recordObservation(ctx, 'receipt', { ...fields, operation, startedMonoMs, outcome: 'unknown', ...errorFields(err) });
    throw err;
  });
}
