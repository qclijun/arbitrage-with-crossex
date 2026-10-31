/**
 * What the funding history cache keeps across a restart: the last published
 * snapshot and the Hyperliquid backfill jobs. It is rebuildable evidence, not a
 * system of record. Restored reads keep their original timestamps and are marked
 * `restored`, so they are shown but never fresh until this process re-reads them.
 * The port is implemented outside core; core never touches the filesystem.
 */
import type { CachedHistoryLeg, HistorySnapshot } from './history-cache';
import type { CollectionProgress } from './history-collection';

export interface PersistedHistory {
  snapshot: { id: string; cutoff: number; publishedAt: number; legs: ReadonlyMap<string, CachedHistoryLeg> };
  /** Hyperliquid backfill jobs by leg key: fixed cutoff, segment, page cursor and the records read so far. */
  progress: ReadonlyMap<string, CollectionProgress>;
  /** Backfill rotation order by leg key. */
  backfilled: ReadonlyMap<string, number>;
}

export type HistoryLoad =
  | { outcome: 'restored'; state: PersistedHistory & { savedAt: number } }
  | { outcome: 'empty' }
  /** The whole cache was unusable and has been deleted; nothing of it is trusted. */
  | { outcome: 'discarded'; reason: string }
  /** The cache file cannot be opened or rebuilt; the terminal runs without it. */
  | { outcome: 'unavailable'; reason: string };

export interface HistoryPersistence {
  load(): Promise<HistoryLoad>;
  /** Writes what changed since the last save; each leg commits on its own. */
  save(state: PersistedHistory): Promise<void>;
  close(): void;
}

/**
 * A point-in-time copy for an asynchronous save. Published snapshots are never
 * mutated, but the refresher keeps extending its backfill jobs in place.
 */
export function captureHistory(snapshot: HistorySnapshot, progress: ReadonlyMap<string, CollectionProgress>,
  backfilled: ReadonlyMap<string, number>): PersistedHistory {
  return {
    snapshot: { id: snapshot.id, cutoff: snapshot.cutoff, publishedAt: snapshot.publishedAt, legs: snapshot.legs },
    progress: new Map([...progress].map(([key, job]) => [key, { ...job, leg: { ...job.leg }, events: [...job.events],
      pages: [...job.pages], ranges: job.ranges ? [...job.ranges] : null }])),
    backfilled: new Map(backfilled),
  };
}

/** The startup snapshot: a distinct ID, so nothing issued before the restart can match it. */
export function restoredSnapshot(state: PersistedHistory & { savedAt: number }): HistorySnapshot & { restored: { savedAt: number } } {
  return { id: `fh-restored-${state.snapshot.id}`, cutoff: state.snapshot.cutoff, publishedAt: state.snapshot.publishedAt,
    legs: state.snapshot.legs, restored: { savedAt: state.savedAt } };
}
