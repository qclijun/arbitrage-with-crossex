import type { ClaimRow } from '../../../../src/engine/claim-types';

export function OwnershipReceipt({ row }: { row: ClaimRow }) {
  return <div className="space-y-2 rounded border border-line p-3 text-xs">
    <p className="font-medium">{row.input.kind} · {row.id}</p>
    <p>Observed {new Date(row.preview.readAt).toISOString()} · preview expires {new Date(row.expiresAt).toISOString()}</p>
    {row.preview.legs.map((l) => <p key={l.contract}>
      {l.contract} {l.side}: actual {l.actual}, claim {l.qty}, {l.remaining} remaining unattributed
    </p>)}
    {row.preview.boros.map((b) => <p key={b.key}>
      Boros {b.marketId} · {b.root} / account {b.accountId} / {b.marketAcc} · claim {b.claimed} {b.base}, {b.remaining} unallocated · expires {new Date(b.maturity * 1000).toISOString()}
      {' · '}{b.sources.map((s) => `${s.venue} ${s.side}`).join(' / ')}
    </p>)}
    <p>{row.preview.attribution.reason}</p>
    {row.status === 'pending' && <p role="status">Pending engine verification — no ownership has been granted yet.</p>}
    {row.status === 'applied' && <p role="status">Applied at {new Date(row.appliedAt!).toISOString()}. Only current ownership changed; historical records and account totals are preserved.</p>}
    {row.status === 'rejected' && <p role="alert">Not claimed: {row.reason}</p>}
  </div>;
}
