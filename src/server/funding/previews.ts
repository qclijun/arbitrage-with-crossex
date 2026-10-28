/**
 * Minted previews (ticket 12), in memory only: a restart forgets them, and a
 * forgotten preview can only be replaced by a new one, never accepted. A
 * preview expires 10 s after its evidence round BEGAN — not after it was
 * shown — and nothing extends it. It is kept a little longer only so an
 * expired acceptance can be answered with a fresh preview of the same request.
 */
import { randomUUID } from 'node:crypto';
import type { Judgement } from './judge';
import { contentHash, type PreviewRequest } from './request';

export const PREVIEW_TTL_MS = 10_000;
const RETAIN_MS = 120_000;

export interface Preview {
  id: string;
  request: PreviewRequest;
  judgement: Judgement;
  contentHash: string;
  readAt: number;
  expiresAt: number;
  /** Admission generation it was minted under; acceptance must match it. */
  generation: number;
}

export class PreviewRegistry {
  private readonly previews = new Map<string, Preview>();

  mint(request: PreviewRequest, judgement: Judgement, readAt: number, generation: number, now: number): Preview {
    for (const [id, p] of this.previews) if (now - p.expiresAt > RETAIN_MS) this.previews.delete(id);
    const preview = { id: randomUUID(), request, judgement, contentHash: contentHash(judgement.content), readAt,
      expiresAt: readAt + PREVIEW_TTL_MS, generation };
    this.previews.set(preview.id, preview);
    return preview;
  }

  get(id: string): Preview | null {
    return this.previews.get(id) ?? null;
  }
}

/** The wire form of a preview: acceptable only without blockers. */
export function previewView(p: Preview) {
  const acceptable = p.judgement.blockers.length === 0;
  return {
    previewId: acceptable ? p.id : null,
    expiresAt: p.expiresAt,
    readAt: p.readAt,
    contentHash: p.contentHash,
    content: p.judgement.content,
    blockers: p.judgement.blockers,
    scenario: p.judgement.scenario,
  };
}
