/** Durable user commands. Routes enqueue; only the normal engine applies them. */
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './db';
import { CLAIM_MAX_AGE_MS, ClaimRefusal, previewClaim } from './claim-preview';
import type { ClaimEvidence, ClaimInput, ClaimPreview, ClaimRow } from './claim-types';
import { SliceRefusal } from './slices';

async function readBounded(read: () => Promise<ClaimEvidence>): Promise<ClaimEvidence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Ownership evidence timed out')), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

export class SliceClaims {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): ClaimRow | null {
    const r = this.db.prepare('SELECT * FROM slice_claim WHERE id = ?').get(id);
    return r ? { id: r.id as string, input: JSON.parse(r.content_json as string), preview: JSON.parse(r.preview_json as string),
      status: r.status as ClaimRow['status'], createdAt: r.created_at as number, expiresAt: r.expires_at as number,
      appliedAt: r.applied_at as number | null, reason: r.reason as string | null } : null;
  }

  list(): ClaimRow[] {
    return (this.db.prepare('SELECT id FROM slice_claim ORDER BY created_at, id').all() as { id: string }[])
      .map((r) => this.get(r.id)!);
  }

  preview(id: string, input: ClaimInput, preview: ClaimPreview, now: number): ClaimRow {
    this.db.prepare("INSERT INTO slice_claim (id, content_json, preview_json, status, created_at, expires_at) VALUES (?,?,?,'preview',?,?)")
      .run(id, JSON.stringify(input), JSON.stringify(preview), now, preview.readAt + CLAIM_MAX_AGE_MS);
    return this.get(id)!;
  }

  confirm(id: string): void { this.db.prepare("UPDATE slice_claim SET status = 'pending' WHERE id = ? AND status = 'preview'").run(id); }
  discard(id: string): void {
    this.db.prepare("UPDATE slice_claim SET status = 'rejected', reason = 'Preview discarded by user' WHERE id = ? AND status = 'preview'").run(id);
  }
  finish(id: string, now: number, reason: string | null): void {
    this.db.prepare('UPDATE slice_claim SET status = ?, applied_at = ?, reason = ? WHERE id = ? AND status = ?')
      .run(reason ? 'rejected' : 'applied', reason ? null : now, reason, id, 'pending');
  }
}

/** An ordinary loop phase: read again, then atomically apply the command or
 * reject it. A crash retries the same durable command, never invents a slice. */
export async function processSliceClaims(store: Store, read: (input: ClaimInput) => Promise<ClaimEvidence>, now: () => number): Promise<void> {
  // One command per pass bounds observation time for unrelated live deals.
  for (const row of store.claims.list().filter((r) => r.status === 'pending').slice(0, 1)) {
    let evidence: ClaimEvidence;
    try { evidence = await readBounded(() => read(row.input)); } catch { store.claims.finish(row.id, now(), 'Current evidence unavailable; preview again.'); continue; }
    try {
      store.atomically(() => {
        if (now() >= row.expiresAt) throw new ClaimRefusal('Preview expired; preview again.');
        const preview = previewClaim(store.slices, row.input, evidence, now());
        if (preview.fingerprint !== row.preview.fingerprint) throw new ClaimRefusal('Positions or ownership changed; preview again.');
        const asOf = now();
        const id = `claim:${row.id}`;
        store.slices.create({ id, kind: row.input.kind, legs: preview.legs.map((l, i) => ({ ...l, leg: String(i) })),
          source: { type: 'current-claim', claimId: row.id, asOf, readAt: evidence.readAt, boros: preview.boros },
          now: asOf, observed: evidence.positions, baselineIncludesRecordedFills: true });
        for (const [i, l] of preview.legs.entries()) {
          store.slices.claim({ sliceId: id, leg: String(i), qty: l.qty, observedActual: l.actual,
            evidence: JSON.stringify({ claimId: row.id, asOf, readAt: evidence.readAt, contract: l.contract }), now: asOf });
        }
        store.claims.finish(row.id, asOf, null);
      });
    } catch (err) {
      if (!(err instanceof ClaimRefusal) && !(err instanceof SliceRefusal)) throw err;
      store.claims.finish(row.id, now(), err.message);
    }
  }
}
