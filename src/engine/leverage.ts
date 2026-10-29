/**
 * Engine-owned leverage (ticket 12). A deal may carry per-leg leverage
 * targets; the engine — the only venue writer — sets them before it places
 * anything, one leg per tick, each a single wire mutation confirmed by a
 * read-back. A refusal, or an unknown outcome the read-back does not confirm,
 * ends the deal with nothing placed. Legs already changed are named in the
 * report, never restored behind the user's back: a restore is another
 * mutation the user did not see.
 */
import { fx } from './fx';
import type { LoopDeps } from './loop';
import type { Action, LegLeverage, PairRow, Projection } from './types';

/** The leverage step this tick, if any: null hands over to decide()'s normal
 * priorities. Runs before them, so neither a deadline nor a hedge can place
 * an order while a target is unconfirmed. */
export function leverageAction(pair: PairRow, p: Projection): Action | null {
  const legs = pair.leverage;
  if (!legs?.length) return null;
  const failed = legs.find((l) => l.state === 'failed');
  if (failed) {
    if (!p.allSettled) return { type: 'idle', reason: 'waiting for orders to settle' };
    return {
      type: 'finish',
      report: { aFilled: p.aFilled, bFilled: p.bFilled, unhedged: pair.b ? p.unhedged : '0', reason: failureReason(pair, legs, failed) },
    };
  }
  const pending = legs.find((l) => l.state === 'pending');
  // A stopped deal never acquired anything; it finishes without leverage.
  if (!pending || pair.mode === 'STOPPING' || pair.mode === 'HALTED') return null;
  return { type: 'setLeverage', leg: pending.leg, leverage: pending.target };
}

const contractOf = (pair: PairRow, leg: LegLeverage['leg']) => (leg === 'A' ? pair.a.contract : pair.b!.contract);

function failureReason(pair: PairRow, legs: LegLeverage[], failed: LegLeverage): string {
  const changed = legs
    .filter((l) => l.state === 'set' && l.previous !== null && !sameLeverage(l.previous, l.target))
    .map((l) => `leg ${l.leg} (${contractOf(pair, l.leg)}) leverage was changed ${l.previous} → ${l.target} and is not restored`);
  return [
    `leverage not confirmed on leg ${failed.leg} (${contractOf(pair, failed.leg)}): ${failed.detail}; nothing was placed`,
    ...changed,
  ].join('. ');
}

/** Leverage values are compared as decimals: '5' and '5.00' are the same. */
export function sameLeverage(a: string, b: string): boolean {
  try {
    return fx(a) === fx(b);
  } catch {
    return false;
  }
}

/** One leg's step: read, and only if it differs, one set plus a read-back. */
export async function performSetLeverage(deps: LoopDeps, pair: PairRow, leg: LegLeverage['leg'], target: string): Promise<void> {
  const entry = pair.leverage!.find((l) => l.leg === leg)!;
  const contract = contractOf(pair, leg);
  const update = (patch: Partial<LegLeverage>) => deps.store.updateLeverage(pair.id, leg, patch);
  const fail = (detail: string) => {
    update({ state: 'failed', detail });
    deps.store.alert('warn', pair.id, `leverage not confirmed on ${contract}: ${detail}`, deps.clock.now());
  };

  const current = await deps.venue.readLeverage(contract, deps.evidence);
  if (current === null) return fail('the current leverage could not be read');
  const previous = entry.previous ?? current;
  if (sameLeverage(current, target)) return update({ state: 'set', previous });
  // Write-ahead: the value before our change survives a crash mid-call.
  if (entry.previous === null) update({ previous });

  const outcome = await deps.venue.setLeverage(contract, target, deps.evidence);
  if (outcome.kind === 'reject') return fail(`refused: ${outcome.label} ${outcome.message}`);
  const back = await deps.venue.readLeverage(contract, deps.evidence);
  if (back !== null && sameLeverage(back, target)) return update({ state: 'set' });
  const moved = back !== null && !sameLeverage(back, previous) ? `; left changed ${previous} → ${back}, not restored` : '';
  const seen = back === null ? 'cannot be read back' : `reads back ${back}, not ${target}${moved}`;
  return fail(outcome.kind === 'ok' ? `accepted but ${seen}` : `outcome unknown (${outcome.message}); ${seen}`);
}
