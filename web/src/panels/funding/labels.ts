/** Plain-language text for the opportunities page's reason codes; an unknown code is shown verbatim. */
import type { BoardWindow } from '../../api/fundingOpportunities';

const REASONS: Record<string, string> = {
  'history-cold-start': 'no history published yet (cold start)',
  'history-clock-behind': 'this clock is behind the snapshot',
  'history-cutoff-behind': 'the snapshot is behind the current UTC hour',
  'history-leg-missing': 'no history for this leg',
  'history-partial': 'history is PARTIAL',
  'history-unknown': 'history is UNKNOWN',
  'history-unsupported': 'history is UNSUPPORTED for this window',
  'history-stale': 'stale (verified over 15 min ago)',
  'historical-source-unsupported': 'the source cannot serve this window',
  'no-history-source': 'no official history source is wired',
  'source-unverified': 'the source is not verified',
  'listing-history-insufficient': 'listed too recently for this window',
  'page-incomplete': 'pagination not proven complete',
  'verification-missing': 'not verified',
  'schedule-unverified': 'settlement schedule not proven',
  'invalid-settlement': 'an unreadable settlement',
  'settlement-rule-mismatch': 'settlements off the proven schedule',
  'settlement-conflict': 'conflicting settled values',
  'missing-settlement': 'missing settlements',
  'special-settlement-semantics-unverified': 'special settlement not understood',
  'symbol-unmapped': 'no proven CrossEx symbol',
  'unit-unsupported': 'not a one-coin contract',
};

/** `short:missing-settlement` → `short: missing settlements`. */
export function reasonText(code: string, underlying = ''): string {
  if (code === 'coin-unsupported') return `${underlying} is not a supported coin`;
  const [side, rest] = code.startsWith('short:') || code.startsWith('long:') ? code.split(/:(.*)/s) : [null, code];
  const text = REASONS[rest] ?? rest;
  return side ? `${side}: ${text}` : text;
}

export const UNPAIRED: Record<string, string> = {
  'identity-conflict': 'claimed as two different assets',
  'underlying-unverified': 'underlying not proven',
  'rate-basis-unverified': 'funding basis not proven',
  'rate-basis-mismatch': 'different funding basis from its peers',
  'no-comparable-peer': 'no comparable contract on another venue',
};

/** UNKNOWN and UNSUPPORTED are different answers: one may resolve, the other cannot. */
export function coverageLabel(coverage: BoardWindow['coverage']): string {
  return coverage === 'complete' ? 'complete' : coverage === 'unavailable' ? 'UNKNOWN' : coverage.toUpperCase();
}

/** The figure a window shows, or why it has none. */
export function windowValue(w: BoardWindow | undefined): { text: string; known: boolean } {
  if (!w) return { text: '—', known: false };
  if (w.netAnnualized === null) return { text: coverageLabel(w.coverage), known: false };
  return { text: pct(w.netAnnualized), known: true };
}

/** An exact decimal fraction as an exact percent, by moving the point: no float. */
export function pctExact(fraction: string): string | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(fraction);
  if (!m) return null;
  const decimals = (m[3] ?? '').padEnd(2, '0');
  const whole = (m[2] + decimals.slice(0, 2)).replace(/^0+(?=\d)/, '');
  const rest = decimals.slice(2).replace(/0+$/, '');
  return `${m[1]}${whole}${rest ? `.${rest}` : ''}`;
}

/** Two decimals for display; a non-zero value too small for them keeps two significant digits instead of reading as 0.00%. */
export function pct(fraction: string): string {
  const exact = pctExact(fraction);
  if (exact === null) return '—';
  const n = Number(exact);
  if (n === 0 || Math.abs(n) >= 0.005) return `${n.toFixed(2)}%`;
  const m = /^(-?)0\.(0*)(\d{1,2})/.exec(exact)!;
  return `${m[1]}0.${m[2]}${m[3]}%`;
}
