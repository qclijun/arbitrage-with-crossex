/**
 * The strategy slice ledger (ticket 15; docs: ownership-and-risk.md).
 *
 * A slice is a long-lived ownership unit — a strategy's legs on exact
 * contracts — that many deals open into, add to and reduce. It holds only
 * ACTUAL quantity, booked from each attached deal leg's cumulative fill by
 * the engine (slice-booking.ts). Targets and hedge reservations are never
 * holdings, and nothing moves between slices.
 *
 * Each contract a slice touches has a book: the signed net the ledger can
 * explain — the position observed when it was first tracked (which stays
 * unattributed) plus every engine fill on it since. slice-reconcile.ts judges
 * a fresh reading against it. The writes here are user commands applied
 * atomically under the same SQLite writer, like the deal commands: create
 * and attach (ticket 12's admission), claim (ticket 17), and recover — the
 * explicit, evidenced reconciliation of an unexplained change. No FIFO, no
 * pro-rata, no backdating.
 */
import type { DatabaseSync } from 'node:sqlite';
import { fx, fxStr } from './fx';
import { inSavepoint } from './ledger/sqlite';
import { ACCOUNT, bookDealFills, bookPendingFills, insertMovement, normContract, type Alert } from './slice-booking';
import {
  bookOf, contractStateOf, getSlice, inFlight, legsOn, listSlices, movementsOf, oppositeHolder, pendingReduceOn,
  reducibleOf, trackedContracts, type ContractBook, type Movement, type SliceSide, type SliceView,
} from './slice-queries';
import { fitsInside, reconcileContract, type ContractState } from './slice-reconcile';

export { ACCOUNT };
export type { Movement, SliceSide, SliceView };

export type SliceKind = 'funding-two-leg' | 'boros-hedge';
export type SliceAction = 'open' | 'add' | 'reduce';
export interface DealLegShape { contract: string; side: 'BUY' | 'SELL'; reduceOnly?: boolean }

export type SliceRefusalCode =
  | 'unknown-slice' | 'unknown-deal' | 'invalid-input' | 'leg-mismatch' | 'contract-in-flight'
  | 'opposite-slice' | 'baseline-missing' | 'not-reconciled' | 'exceeds-unattributed' | 'invalid-adjustment';

/** A deliberate "no" that changed nothing. */
export class SliceRefusal extends Error {
  constructor(readonly code: SliceRefusalCode, message: string) {
    super(message);
    this.name = 'SliceRefusal';
  }

  /** 400 for a request that cannot be right; 409 for one the ledger's
   * current state refuses. */
  get status(): 400 | 409 {
    return this.code === 'unknown-slice' || this.code === 'leg-mismatch' || this.code === 'invalid-input' ? 400 : 409;
  }
}

const no = (code: SliceRefusalCode, message: string): SliceRefusal => new SliceRefusal(code, message);
const opensAs = (side: 'BUY' | 'SELL'): SliceSide => (side === 'BUY' ? 'long' : 'short');

export class SliceLedger {
  constructor(private readonly db: DatabaseSync, private readonly alert: Alert) {}

  create(input: {
    id: string; kind: SliceKind; source: unknown; now: number;
    legs: Array<{ leg: string; contract: string; side: SliceSide }>;
    /** Signed actual net per contract, read fresh, for contracts not yet tracked. */
    observed: Record<string, string>;
  }): void {
    const contracts = input.legs.map((l) => normContract(l.contract));
    if (!input.id || !input.legs.length || new Set(contracts).size !== contracts.length ||
      new Set(input.legs.map((l) => l.leg)).size !== input.legs.length) {
      throw no('invalid-input', 'a slice needs an id and distinct legs on distinct contracts');
    }
    if (this.get(input.id)) throw no('invalid-input', `slice ${input.id} already exists`);
    inSavepoint(this.db, () => {
      for (const [i, l] of input.legs.entries()) {
        const contract = contracts[i];
        if (inFlight(this.db, contract)) throw no('contract-in-flight', `execution on ${contract} is in flight; a slice can start only on a settled contract`);
        this.refuseOpposite(contract, l.side);
        if (!bookOf(this.db, contract)) {
          const seen = input.observed[contract] ?? input.observed[l.contract];
          if (seen === undefined) throw no('baseline-missing', `no fresh position reading for ${contract}`);
          this.db.prepare('INSERT INTO contract_book (account, contract, explained, baseline_at, flag) VALUES (?,?,?,?,NULL)')
            .run(ACCOUNT, contract, fxStr(fx(seen)), input.now);
        }
      }
      this.db.prepare('INSERT INTO strategy_slice (id, kind, source_json, created_at) VALUES (?,?,?,?)')
        .run(input.id, input.kind, JSON.stringify(input.source ?? null), input.now);
      for (const [i, l] of input.legs.entries()) {
        this.db.prepare("INSERT INTO slice_leg (slice_id, leg, account, contract, side, unit, qty) VALUES (?,?,?,?,?,'base','0')")
          .run(input.id, l.leg, ACCOUNT, contracts[i], l.side);
      }
    });
  }

  /** Which slice legs a deal's A/B legs move: the slice's own legs, in its
   * direction for open/add (with no slice holding the contract the other
   * way), reduce-only against it for reduce. Throws a refusal; writes nothing. */
  mapLegs(sliceId: string, action: SliceAction, legs: { a: DealLegShape; b: DealLegShape | null }): { aLeg: string; bLeg: string | null } {
    const slice = this.get(sliceId);
    if (!slice) throw no('unknown-slice', `unknown slice ${sliceId}`);
    const legFor = (d: DealLegShape): string => {
      const l = slice.legs.find((s) => s.contract === normContract(d.contract));
      const opens = opensAs(d.side) === l?.side;
      if (!l || (action === 'reduce' ? opens || !d.reduceOnly : !opens || d.reduceOnly)) {
        throw no('leg-mismatch', `${d.side} ${d.contract} does not ${action} a leg of slice ${sliceId}`);
      }
      if (action !== 'reduce') this.refuseOpposite(l.contract, l.side);
      return l.leg;
    };
    const aLeg = legFor(legs.a);
    const bLeg = legs.b ? legFor(legs.b) : null;
    if (aLeg === bLeg) throw no('leg-mismatch', `both deal legs map to slice leg ${aLeg}`);
    return { aLeg, bLeg };
  }

  /** Name the slice a deal moves (see mapLegs), before it has filled anything. */
  attach(dealId: string, sliceId: string, action: SliceAction): void {
    const pair = this.db.prepare('SELECT a_contract, a_side, a_reduce_only, b_contract, b_side, b_reduce_only FROM pair WHERE id = ?')
      .get(dealId) as { a_contract: string; a_side: 'BUY' | 'SELL'; a_reduce_only: number; b_contract: string | null; b_side: 'BUY' | 'SELL' | null; b_reduce_only: number } | undefined;
    if (!pair) throw no('unknown-deal', `unknown deal ${dealId}`);
    if (this.db.prepare('SELECT 1 FROM deal_slice WHERE deal_id = ?').get(dealId)) throw no('invalid-input', `deal ${dealId} already names a slice`);
    // Fills before the attachment are already in the contract's explained net;
    // they would stay unattributed while the slice claimed the rest.
    if (this.db.prepare("SELECT 1 FROM orders WHERE pair_id = ? AND cum_qty NOT IN ('0', '')").get(dealId)) {
      throw no('invalid-input', `deal ${dealId} already has fills; a slice must be named before it trades`);
    }
    const { aLeg, bLeg } = this.mapLegs(sliceId, action, {
      a: { contract: pair.a_contract, side: pair.a_side, reduceOnly: pair.a_reduce_only === 1 },
      b: pair.b_contract ? { contract: pair.b_contract, side: pair.b_side!, reduceOnly: pair.b_reduce_only === 1 } : null,
    });
    this.db.prepare('INSERT INTO deal_slice (deal_id, slice_id, action, a_leg, b_leg) VALUES (?,?,?,?,?)').run(dealId, sliceId, action, aLeg, bLeg);
  }

  bookFills(dealId: string, now: number): void {
    inSavepoint(this.db, () => bookDealFills(this.db, this.alert, dealId, now));
  }

  bookPending(now: number): void {
    inSavepoint(this.db, () => bookPendingFills(this.db, this.alert, now));
  }

  /** Attribute proven, currently unattributed quantity to a slice from now on
   * (ticket 17's claim). The fresh reading must reconcile exactly. */
  claim(input: { sliceId: string; leg: string; qty: string; observedActual: string; evidence: string; now: number }): void {
    const l = this.get(input.sliceId)?.legs.find((x) => x.leg === input.leg);
    if (!l) throw no('unknown-slice', `unknown slice leg ${input.sliceId}/${input.leg}`);
    const qty = fx(input.qty);
    if (qty <= 0n || !input.evidence.trim()) throw no('invalid-input', 'a claim needs a positive quantity and evidence');
    this.bookPending(input.now);
    const rec = reconcileContract(this.contractState(l.contract), input.observedActual);
    if (rec.status !== 'reconciled') {
      throw no('not-reconciled', `${l.contract} is ${rec.status}: the ledger cannot explain the position as observed; reconcile it first`);
    }
    const unattributed = fx(rec.unattributed!);
    const available = l.side === 'long' ? unattributed : -unattributed;
    if (qty > available) throw no('exceeds-unattributed', `only ${fxStr(available > 0n ? available : 0n)} ${l.side} on ${l.contract} is unattributed`);
    inSavepoint(this.db, () => {
      this.setQty(input.sliceId, input.leg, fx(l.qty) + qty);
      insertMovement(this.db, { sliceId: input.sliceId, leg: input.leg, contract: l.contract, delta: qty, kind: 'claim', now: input.now, evidence: input.evidence });
    });
  }

  /** The user's explicit reconciliation of an unexplained change: the
   * observed position becomes the new explained baseline, with the stated
   * per-slice adjustments; the remainder is unattributed. */
  recover(input: {
    contract: string; observedActual: string; evidence: string; now: number;
    adjustments: Array<{ sliceId: string; leg: string; delta: string }>;
  }): void {
    const contract = normContract(input.contract);
    if (!bookOf(this.db, contract)) throw no('invalid-input', `${contract} has no slice ledger to recover`);
    if (inFlight(this.db, contract)) throw no('contract-in-flight', `execution on ${contract} is in flight; recover after it settles`);
    if (!input.evidence.trim()) throw no('invalid-input', 'a recovery needs evidence');
    this.bookPending(input.now); // a fill booked late would otherwise count twice
    const book = bookOf(this.db, contract)!;
    const legs = legsOn(this.db, contract).map((l) => ({ ...l }));
    for (const a of input.adjustments) {
      const l = legs.find((x) => x.sliceId === a.sliceId && x.leg === a.leg);
      if (!l) throw no('invalid-adjustment', `slice leg ${a.sliceId}/${a.leg} is not on ${contract}`);
      const next = fx(l.qty) + fx(a.delta);
      if (next < 0n) throw no('invalid-adjustment', `slice ${a.sliceId} cannot go below zero on ${contract}`);
      l.qty = fxStr(next);
    }
    const observed = fx(input.observedActual);
    if (!fitsInside(legs, observed)) {
      throw no('invalid-adjustment', `the adjusted slices do not fit the observed ${fxStr(observed)} on ${contract}`);
    }
    inSavepoint(this.db, () => {
      for (const a of input.adjustments) {
        this.setQty(a.sliceId, a.leg, fx(legs.find((x) => x.sliceId === a.sliceId && x.leg === a.leg)!.qty));
        if (fx(a.delta) !== 0n) insertMovement(this.db, { sliceId: a.sliceId, leg: a.leg, contract, delta: fx(a.delta), kind: 'recover', now: input.now, evidence: input.evidence });
      }
      insertMovement(this.db, { sliceId: null, leg: null, contract, delta: observed - fx(book.explained), kind: 'external', now: input.now, evidence: input.evidence });
      this.db.prepare('UPDATE contract_book SET explained = ?, baseline_at = ?, flag = NULL WHERE account = ? AND contract = ?')
        .run(fxStr(observed), input.now, ACCOUNT, contract);
    });
  }

  get(id: string): SliceView | null { return getSlice(this.db, id); }
  list(): SliceView[] { return listSlices(this.db); }
  movements(sliceId: string | null): Movement[] { return movementsOf(this.db, sliceId); }
  book(contract: string): ContractBook | null { return bookOf(this.db, contract); }
  trackedContracts(): string[] { return trackedContracts(this.db); }
  contractState(contract: string): ContractState { return contractStateOf(this.db, contract); }
  pendingReduce(contract: string): string { return pendingReduceOn(this.db, contract); }

  reducible(sliceId: string): Record<string, { qty: string; reserved: string; reducible: string }> {
    const slice = this.get(sliceId);
    if (!slice) throw no('unknown-slice', `unknown slice ${sliceId}`);
    return reducibleOf(this.db, slice);
  }

  private refuseOpposite(contract: string, side: SliceSide): void {
    const holder = oppositeHolder(this.db, contract, side);
    if (holder) throw no('opposite-slice', `${contract} is held the other way by slice ${holder}; slices on one net position must point the same way`);
  }

  private setQty(sliceId: string, leg: string, qty: bigint): void {
    this.db.prepare('UPDATE slice_leg SET qty = ? WHERE slice_id = ? AND leg = ?').run(fxStr(qty), sliceId, leg);
  }
}
