/**
 * The page's sent funding intents (ticket 14), restored from this browser's
 * durable record and resolved by their exact ids: an answer that never came,
 * a refresh, or another tab all end at the same lookup. While any intent has
 * no known result, nothing new may be opened from the page. Only a refusal or
 * the server's proof that its preview can never be accepted releases one;
 * nothing here resends, re-creates, or unwinds anything.
 */
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FINAL_MODES, lookupFundingIntent, type FundingAcceptBody, type FundingReceipt, type IntentLookup } from '../../api/fundingIntents';
import { forgetSubmission, loadSubmissions, saveSubmission, SUBMISSION_KEY_PREFIX, type SubmissionRecord } from './submissions';

export type SubmissionState =
  | { kind: 'sending' }
  | { kind: 'checking' }
  | { kind: 'pending'; until: number | null }
  | { kind: 'lookup-failed'; error: string }
  | { kind: 'accepted'; receipt: FundingReceipt };

export interface Submission { record: SubmissionRecord; state: SubmissionState }

export interface Notice { candidateId: string; text: string }

interface SubmissionsApi {
  all: Submission[];
  forCandidate: (candidateId: string) => Submission[];
  /** Why no new open may start on this page, or null. */
  blocked: string | null;
  /** What the page released or could not keep, by pair, newest last. */
  notices: Notice[];
  /** Durably record the intent; any answer but null says why it was not recorded and must not be sent. */
  record: (candidateId: string, body: FundingAcceptBody) => string | null;
  /** The single send's outcome. A refusal must be one the server made before writing anything. */
  settled: (intentId: string, outcome: { receipt: FundingReceipt } | { refused: true } | { unknown: true }) => void;
  /** Forget a finished receipt; the ledger keeps it. */
  dismiss: (intentId: string) => void;
}

const Ctx = createContext<SubmissionsApi | null>(null);

const lookupKey = (intentId: string) => ['funding', 'submission', intentId];

const pollMs = (data: IntentLookup | undefined, failed: boolean): number | false => {
  if (failed) return 2_000;
  if (data?.kind === 'accepted') return FINAL_MODES.has(data.receipt.deal.mode) ? false : 2_000;
  return 1_000;
};

function stateOf(sending: boolean, q: { data?: IntentLookup; isError: boolean; error: unknown }): SubmissionState {
  if (sending) return { kind: 'sending' };
  if (q.data?.kind === 'accepted') return { kind: 'accepted', receipt: q.data.receipt };
  if (q.isError) return { kind: 'lookup-failed', error: (q.error as Error).message };
  if (q.data?.kind === 'pending') return { kind: 'pending', until: q.data.until };
  return { kind: 'checking' };
}

export function FundingSubmissionsProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [loaded, setLoaded] = useState(loadSubmissions);
  // Every record this page has seen: one that vanishes from storage while
  // unresolved is still looked up here, and written back.
  const [seen, setSeen] = useState<Record<string, SubmissionRecord>>(() => (loaded.ok ? loaded.records : {}));
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const [notices, setNotices] = useState<Notice[]>([]);
  // Released here even if the stored record could not be removed; a reload looks such a record up again.
  const [released, setReleased] = useState<ReadonlySet<string>>(new Set());
  const notify = useCallback((n: Notice) => setNotices((all) => [...all, n]), []);

  const reload = useCallback(() => {
    const next = loadSubmissions();
    setLoaded(next);
    if (next.ok) setSeen((s) => ({ ...s, ...next.records }));
  }, []);

  // Another tab's record is this page's record too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith(SUBMISSION_KEY_PREFIX)) reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [reload]);

  const records = useMemo(() => Object.values(seen).filter((r) => !released.has(r.body.intentId)).sort((a, b) => a.savedAt - b.savedAt),
    [seen, released]);
  const lookups = useQueries({
    queries: records.map((r) => ({
      queryKey: lookupKey(r.body.intentId),
      queryFn: () => lookupFundingIntent(r.body),
      enabled: !inFlight.has(r.body.intentId),
      refetchInterval: (q: { state: { data?: IntentLookup; status: string } }) => pollMs(q.state.data, q.state.status === 'error'),
      retry: false,
    })),
  });
  const all: Submission[] = records.map((record, i) => ({ record, state: stateOf(inFlight.has(record.body.intentId), lookups[i]) }));
  const current = useRef(all);
  current.current = all;

  const release = useCallback((record: SubmissionRecord, notice?: string) => {
    const { candidateId, body: { intentId } } = record;
    if (!forgetSubmission(intentId)) {
      notify({ candidateId, text: `Released here, but could not remove this browser's record of intent ${intentId}; a reload will look it up again.` });
    }
    setReleased((s) => new Set(s).add(intentId));
    client.removeQueries({ queryKey: lookupKey(intentId) });
    reload();
    if (notice) notify({ candidateId, text: notice });
  }, [client, notify, reload]);

  const neverIds = lookups.map((q, i) => (q.data?.kind === 'never' ? `${records[i].body.intentId}:${q.data.reason}` : '')).join(',');
  useEffect(() => {
    lookups.forEach((q, i) => {
      if (q.data?.kind !== 'never') return;
      const id = records[i].body.intentId;
      release(records[i], `Intent ${id} was not accepted (${q.data.reason}) and can no longer be; you may preview again.`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a lookup first proves "never"
  }, [neverIds]);

  // An unresolved record gone from storage (cleared, or lost to another tab) is written back.
  const missing = loaded.ok ? all.filter((s) => s.state.kind !== 'accepted' && !loaded.records[s.record.body.intentId]) : [];
  const missingIds = missing.map((s) => s.record.body.intentId).join(',');
  useEffect(() => {
    missing.forEach(({ record }) => {
      if (!saveSubmission(record)) {
        notify({ candidateId: record.candidateId,
          text: `This browser lost its record of intent ${record.body.intentId} and could not write it back; it is looked up only while this page stays open.` });
      }
    });
    if (missing.length) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a record first goes missing
  }, [missingIds]);

  const unresolved = all.find((s) => s.state.kind !== 'accepted');
  const blocked = !loaded.ok
    ? `${loaded.error}: an intent sent earlier could not be checked, so no new open may start from this page.`
    : unresolved ? `Intent ${unresolved.record.body.intentId} has no known result yet: no new open from this page.` : null;

  const record = useCallback((candidateId: string, body: FundingAcceptBody): string | null => {
    // Storage is read again: another tab may have sent an intent this page has not heard of yet.
    const fresh = loadSubmissions();
    if (!fresh.ok) return fresh.error;
    const accepted = new Set(current.current.filter((s) => s.state.kind === 'accepted').map((s) => s.record.body.intentId));
    const other = Object.values(fresh.records).find((r) => !accepted.has(r.body.intentId) && !released.has(r.body.intentId));
    if (other) {
      reload();
      return `intent ${other.body.intentId} has no known result yet`;
    }
    if (!saveSubmission({ candidateId, body, savedAt: Date.now() })) {
      return 'this browser could not record the intent, so a lost answer could not be looked up after a reload';
    }
    setInFlight((s) => new Set(s).add(body.intentId));
    reload();
    return null;
  }, [released, reload]);

  const settled = useCallback<SubmissionsApi['settled']>((intentId, outcome) => {
    const sent = current.current.find((s) => s.record.body.intentId === intentId);
    if ('refused' in outcome) {
      if (sent) release(sent.record);
    } else if ('receipt' in outcome) {
      const accepted: IntentLookup = { kind: 'accepted', receipt: outcome.receipt };
      client.setQueryData(lookupKey(intentId), accepted);
    }
    setInFlight((s) => {
      const next = new Set(s);
      next.delete(intentId);
      return next;
    });
  }, [client, release]);

  const api: SubmissionsApi = {
    all, blocked, notices, record, settled,
    forCandidate: (candidateId) => all.filter((s) => s.record.candidateId === candidateId),
    dismiss: (intentId) => {
      const sent = all.find((s) => s.record.body.intentId === intentId);
      if (sent) release(sent.record);
    },
  };
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useFundingSubmissions(): SubmissionsApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useFundingSubmissions needs a FundingSubmissionsProvider');
  return api;
}
