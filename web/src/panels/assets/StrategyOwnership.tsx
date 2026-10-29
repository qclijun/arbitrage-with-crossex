import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaimEvidence, ClaimInput, ClaimRow } from '../../../../src/engine/claim-types';
import { ApiError, fetchJson, postJson } from '../../api/client';
import { useStrategySlices } from '../../api/sliceQueries';
import { OwnershipReceipt } from './OwnershipReceipt';

export function StrategyOwnership({ address, disabled = false }: { address?: string | null; disabled?: boolean }) {
  const client = useQueryClient();
  const [kind, setKind] = useState<ClaimInput['kind']>('funding-two-leg');
  const [root, setRoot] = useState(address ?? '');
  const [long, setLong] = useState('');
  const [short, setShort] = useState('');
  const [qty, setQty] = useState('');
  const [borosQty, setBorosQty] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ClaimRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const queryRoot = kind === 'boros-hedge' && /^0x[0-9a-fA-F]{40}$/.test(root) ? root : '';
  const evidence = useQuery({ queryKey: ['claim-evidence', queryRoot], retry: false,
    queryFn: () => fetchJson<ClaimEvidence>(`/slices/claim-evidence${queryRoot ? `?root=${encodeURIComponent(queryRoot)}` : ''}`) });
  const history = useQuery({ queryKey: ['slice-claims'], retry: false,
    queryFn: () => fetchJson<ClaimRow[]>('/slices/claims'), refetchInterval: 2_000 });
  const slices = useStrategySlices();
  const pending = history.data?.find((r) => r.status === 'pending');
  const unconfirmed = history.data?.find((r) => r.status === 'preview' && r.confirmationPossible !== false);
  const active = selected ?? pending ?? unconfirmed ?? null;
  const detail = useQuery({ queryKey: ['slice-claim', active?.id], enabled: !!active, retry: false,
    queryFn: () => fetchJson<ClaimRow>(`/slices/claims/${encodeURIComponent(active!.id)}`), refetchInterval: 2_000 });
  const row = detail.data ?? active;
  const locked = disabled || busy || uncertain || !!pending || row?.status === 'pending' || !history.data || history.isError;
  useEffect(() => {
    if (detail.data && (detail.data.status !== 'preview' || detail.data.confirmationPossible === false)) {
      setUncertain(false);
      if (detail.data.status === 'applied' || detail.data.status === 'pending') setError('');
    }
  }, [detail.data]);
  const positions = Object.entries(evidence.data?.positions ?? {});
  const choices = (side: 'long' | 'short') => positions.filter(([contract, quantity]) =>
    evidence.data?.contracts.includes(contract) && quantity !== '0' && (quantity.startsWith('-') ? 'short' : 'long') === side);
  const preview = async () => {
    if (sending.current || locked) return;
    sending.current = true; setBusy(true); setError('');
    try {
      const input: ClaimInput = { kind, legs: [{ contract: long, side: 'long', qty }, { contract: short, side: 'short', qty }],
        boros: kind === 'boros-hedge' ? Object.entries(borosQty).filter(([, amount]) => amount !== '').map(([key, amount]) => ({ key, qty: amount })) : [],
        ...(kind === 'boros-hedge' ? { root } : {}) };
      const next = await postJson<ClaimRow>('/slices/claims/preview', input);
      client.setQueryData(['slice-claim', next.id], next); setSelected(next);
    } catch (err) { setError((err as Error).message); }
    finally { sending.current = false; setBusy(false); }
  };
  const confirm = async () => {
    if (!row || sending.current || row.status !== 'preview') return;
    sending.current = true; setBusy(true); setError('');
    try {
      const next = await postJson<ClaimRow>(`/slices/claims/${encodeURIComponent(row.id)}/confirm`, {});
      client.setQueryData(['slice-claim', row.id], next); setSelected(next);
    } catch (err) {
      setError((err as Error).message);
      setUncertain(true);
      // A lost response must query this command, never create another one.
      try {
        const found = await fetchJson<ClaimRow>(`/slices/claims/${encodeURIComponent(row.id)}`);
        client.setQueryData(['slice-claim', row.id], found); setSelected(found);
        const refused = err instanceof ApiError && err.httpStatus !== undefined && err.httpStatus >= 400 && err.httpStatus < 500;
        setUncertain(!refused && found.status === 'preview' && found.confirmationPossible !== false);
      } catch { /* Keep blocked until the original command can be queried. */ }
    } finally {
      await client.invalidateQueries({ queryKey: ['slice-claims'] });
      await client.invalidateQueries({ queryKey: ['slices'] });
      sending.current = false; setBusy(false);
    }
  };
  const reset = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true);
    try {
      if (row?.status === 'preview') {
        const found = await postJson<ClaimRow>(`/slices/claims/${encodeURIComponent(row.id)}/discard`, {});
        client.setQueryData(['slice-claim', row.id], found);
        if (found.status === 'pending' || found.status === 'applied') { setSelected(found); return; }
      }
      setSelected(null); setUncertain(false); setError('');
      await client.invalidateQueries({ queryKey: ['slice-claims'] });
      await evidence.refetch();
    } catch (err) { setError((err as Error).message); }
    finally { sending.current = false; setBusy(false); }
  };
  return <div className="my-4 space-y-3 rounded border border-line p-4 text-xs">
    <h3 className="font-medium">Strategy ownership</h3>
    <p>Choose proven current unattributed quantity. This records ownership only, sends no trade and grants no trading permission. Past holdings and profit are never backfilled.</p>
    <fieldset disabled={locked || !!row} className="space-y-2">
      <label className="block">Strategy <select aria-label="Strategy" value={kind} onChange={(e) => { setKind(e.target.value as ClaimInput['kind']); setSelected(null); }}>
        <option value="funding-two-leg">Floating perpetual two-leg</option><option value="boros-hedge">Boros hedge</option>
      </select></label>
      {kind === 'boros-hedge' && <label className="block">Boros root <input aria-label="Boros root" value={root} onChange={(e) => { setRoot(e.target.value); setBorosQty({}); setSelected(null); }} /></label>}
      {(['long', 'short'] as const).map((side) => <label className="block" key={side}>
        {side === 'long' ? 'Long' : 'Short'} contract <select aria-label={`${side === 'long' ? 'Long' : 'Short'} contract`} value={side === 'long' ? long : short}
          onChange={(e) => { (side === 'long' ? setLong : setShort)(e.target.value); setSelected(null); }}>
          <option value="">Select exact contract</option>
          {choices(side).map(([contract, amount]) => <option key={contract} value={contract}>{contract} {side} — {amount.replace(/^-/, '')}</option>)}
        </select>
      </label>)}
      <label className="block">Base quantity to claim <input aria-label="Base quantity to claim" inputMode="decimal" value={qty} onChange={(e) => { setQty(e.target.value); setSelected(null); }} /></label>
      {kind === 'boros-hedge' && <div>
        <p>Select each physical Boros holding and its quantity. Non-base collateral units cannot establish exact base ownership.</p>
        {evidence.data?.boros?.map((b) => <label className="block" key={b.key}>
          Market {b.marketId} / {b.marketAcc} · {b.qty} {b.unit} · {b.sources.map((s) => `${s.venue} ${s.side}`).join(' / ')}
          <input aria-label={`Boros quantity ${b.marketId} ${b.marketAcc}`} disabled={b.unit !== 'base'} value={borosQty[b.key] ?? ''}
            onChange={(e) => { setBorosQty({ ...borosQty, [b.key]: e.target.value }); setSelected(null); }} />
        </label>)}
      </div>}
      <button type="button" disabled={locked || !!row || !long || !short || !qty || !evidence.data || evidence.isError} onClick={() => void preview()}>Preview ownership</button>
      <button type="button" onClick={() => void evidence.refetch()}>Refresh current evidence</button>
    </fieldset>
    {evidence.isError && <p role="alert">Current evidence unavailable. No ownership can be claimed.</p>}
    {history.isError && <p role="alert">Claim history unavailable. New claims are blocked until it can be read.</p>}
    {error && <p role="alert">{error}</p>}
    {uncertain && <p role="alert">Confirmation outcome unknown. Query the original command before continuing.
      <button onClick={async () => { const result = await detail.refetch(); if (result.data) {
        setSelected(result.data); setUncertain(result.data.status === 'preview' && result.data.confirmationPossible !== false);
      } }}>Query original claim</button>
    </p>}
    {row && <OwnershipReceipt row={row} />}
    {row?.status === 'preview' && <button type="button" disabled={locked || row.confirmationPossible === false} onClick={() => void confirm()}>Confirm current ownership</button>}
    {row && row.status !== 'pending' && !uncertain && <button type="button" disabled={busy} onClick={() => void reset()}>Review another quantity</button>}
    {!!history.data?.length && <div>Recorded claims: {history.data.map((r) => <button key={r.id} className="mr-2" onClick={() => setSelected(r)}>{r.id} · {r.status}</button>)}</div>}
    {slices.data?.slices.map((s) => <div key={s.id} className="border-t border-line pt-2">
      <p>{s.id} · {s.kind} · current attribution from {new Date(s.createdAt).toISOString()}</p>
      {s.legs.map((l) => <p key={l.leg}>{l.contract} {l.side}: {l.qty} {l.unit}</p>)}
      <p>Slice funding / fees / actual profit / equity return: UNKNOWN. Account and contract totals above are separate aggregates.</p>
    </div>)}
    {slices.data?.contracts.map((c) => <p key={c.contract}>{c.contract}: {c.status}, {c.unattributed ?? 'UNKNOWN'} signed unattributed</p>)}
    {slices.isError && <p role="alert">Current slice reconciliation unavailable (UNKNOWN).</p>}
  </div>;
}
