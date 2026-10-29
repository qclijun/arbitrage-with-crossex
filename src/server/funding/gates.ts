/**
 * The account-side gates of a funding acceptance (ticket 12), pure over one
 * evidence round: position and execution conflicts on both contracts, the
 * borrow carry the scenario must charge, and margin. An unread source is a
 * blocker, never a pass.
 */
import type { CrossexAccount, CrossexInterestRate } from 'gate-api';
import { add, cmp, decimal, div, exact, mul, sign, sum, type Exact } from '../../core/funding/exact';
import type { BorrowEvidence, FundingScenario, Side } from '../../core/funding/scenario';
import { parseSymbol } from '../../core/numbers';
import type { Reconciliation } from '../../engine/slice-reconcile';
import { fx } from '../../engine/fx';

export interface Blocker { code: string; message: string }

/** The slice ledger and engine, as the gates see them. */
export interface LedgerView {
  /** null when no slice has ever tracked the contract. */
  reconcile(contract: string, actual: string): Reconciliation | null;
  activeDeals(contracts: string[]): string[];
}

/** Opening a short sells: its net goes negative. */
const SIGN: Record<Side, 1n | -1n> = { short: -1n, long: 1n };

export function positionBlockers(
  contracts: Record<Side, string>,
  positions: Map<string, string> | null,
  openOrders: Set<string> | null,
  ledger: LedgerView,
): Blocker[] {
  const out: Blocker[] = [];
  const no = (code: string, message: string) => out.push({ code, message });
  const deals = ledger.activeDeals(Object.values(contracts));
  if (deals.length) no('active-deal', `an unfinished deal already works these contracts (${deals.join(', ')})`);
  if (!openOrders) no('open-orders-unknown', 'open orders could not be read');
  if (!positions) no('positions-unknown', 'positions could not be read');
  for (const side of ['short', 'long'] as const) {
    const contract = contracts[side].toUpperCase();
    if (openOrders?.has(contract)) no('open-order', `an open order is working on ${contract}`);
    if (!positions) continue;
    const held = positions.get(contract) ?? '0';
    const heldFx = fx(held);
    if (heldFx !== 0n && (heldFx > 0n ? 1n : -1n) !== SIGN[side]) {
      no('opposite-position', `${contract} holds ${held}, opposite to this ${side} leg; opening would first reduce it`);
      continue;
    }
    // Sharing a same-side position needs every unit of it owned by a slice
    // and the contract reconciled; an unattributed old position is not ours.
    const rec = ledger.reconcile(contract, held);
    if (rec === null) {
      if (heldFx !== 0n) no('unattributed-position', `${contract} already holds ${held} that no strategy slice owns; it cannot be shared`);
    } else if (rec.status !== 'reconciled' || fx(rec.unattributed ?? '1') !== 0n) {
      no('contract-unreconciled',
        `${contract} is ${rec.status} in the slice ledger (explains ${rec.explained}, holds ${held}, unattributed ${rec.unattributed})`);
    }
  }
  return out;
}

const ACCOUNT_SOURCE = 'GET /crossex/accounts';
const owes = (liability: string | undefined): boolean => sign(exact(liability ?? '0') ?? { n: 1n, d: 1n }) !== 0;

/** The carry this position adds: none when the account owes nothing in the
 * legs' quote coins, the existing liability's interest when it owes one. */
export function borrowEvidence(
  account: CrossexAccount | null,
  interest: CrossexInterestRate[] | null,
  quotes: string[],
  readAt: number,
): BorrowEvidence {
  if (!account) return { status: 'unknown', reason: 'account-unread' };
  const liable = (account.assets ?? []).filter((a) => quotes.includes((a.coin ?? '').toUpperCase()) && owes(a.liability));
  if (!liable.length) {
    return { status: 'not-applicable', source: ACCOUNT_SOURCE, at: readAt, basis: 'real',
      evidence: `the account owes no ${quotes.join('/')} and margin is checked to cover this position` };
  }
  const coins = new Set(liable.map((a) => a.coin!.toUpperCase()));
  if (coins.size > 1 || liable.some((a) => !exact(a.liability ?? ''))) return { status: 'unknown', reason: 'liabilities-unmodeled' };
  const coin = [...coins][0];
  const principal = sum(liable.map((a) => exact(a.liability!)!));
  const rates = new Set((interest ?? []).filter((r) => r.coin?.toUpperCase() === coin).map((r) => r.hourInterestRate));
  const hourly = rates.size === 1 ? exact([...rates][0]) : null;
  if (!interest || !hourly) return { status: 'unknown', reason: 'interest-rate-unknown' };
  return { status: 'known', currency: coin, principal: decimal(principal), dailyRate: decimal(mul(hourly, { n: 24n, d: 1n })),
    source: `${ACCOUNT_SOURCE} liability × GET /crossex/interest_rate`, at: readAt, basis: 'real' };
}

/** Initial margin at the confirmed leverage, plus both legs' taker fee, must
 * fit the available margin. Amounts in the scenario's common currency. */
export function marginBlocker(
  account: CrossexAccount | null,
  scenario: FundingScenario,
  leverage: Record<Side, string>,
  takers: Record<Side, string> | null,
): Blocker | null {
  const available = account ? exact(account.availableMargin ?? '') : null;
  const legs = (['short', 'long'] as const).map((side) => {
    const notional = scenario.legs[side].notional;
    const n = notional.status === 'known' ? exact(notional.value) : null;
    return { n, lev: exact(leverage[side]), fee: takers ? exact(takers[side]) : null };
  });
  if (!available || legs.some((l) => !l.n || !l.lev || !l.fee)) {
    return { code: 'margin-unknown', message: 'available margin or the position notional could not be established' };
  }
  const required = legs.reduce<Exact>((acc, l) => add(acc, add(div(l.n!, l.lev!), mul(l.n!, l.fee!))), { n: 0n, d: 1n });
  if (cmp(required, available) > 0) {
    return { code: 'margin-insufficient',
      message: `needs ${decimal(required)} ${scenario.currency} of margin with fee reserve; ${decimal(available)} is available` };
  }
  return null;
}

export const quoteOf = (symbol: string): string => parseSymbol(symbol).quote.toUpperCase();
