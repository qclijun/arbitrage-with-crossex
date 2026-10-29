/**
 * Engine-owned leverage (ticket 12): a deal that carries per-leg leverage
 * targets has the engine set them, one leg per tick, before it places any
 * order. A refusal, or an unknown outcome the read-back does not confirm, ends
 * the deal with nothing placed and names it; legs already set are reported,
 * never silently restored.
 */
import { describe, expect, it } from 'vitest';
import { A_CONTRACT, B_CONTRACT, mkWorld } from './engine-sim';

const targets = [{ leg: 'A' as const, target: '3' }, { leg: 'B' as const, target: '5' }];

function world() {
  const w = mkWorld({ leverage: targets, deadlineInMs: null });
  w.venue.leverage.set(A_CONTRACT, '10');
  w.venue.leverage.set(B_CONTRACT, '5');
  return w;
}

const report = (w: ReturnType<typeof mkWorld>) => JSON.parse(w.store.getPair(w.pairId)!.reportJson ?? 'null');

describe('engine-owned leverage', () => {
  it('sets each leg one wire call per tick, skips a leg already there, then places', async () => {
    const w = world();
    await w.step();
    expect(w.venue.leverageCalls).toEqual([{ contract: A_CONTRACT, leverage: '3' }]);
    expect(w.venue.createCalls).toEqual([]);

    await w.step(); // B already reads 5: confirmed with no mutation
    expect(w.venue.leverageCalls).toHaveLength(1);
    expect(w.venue.createCalls).toEqual([]);
    expect(w.store.getPair(w.pairId)!.leverage).toEqual([
      { leg: 'A', target: '3', state: 'set', previous: '10', detail: null },
      { leg: 'B', target: '5', state: 'set', previous: '5', detail: null },
    ]);

    await w.step();
    expect(w.venue.createCalls).toHaveLength(1);
    expect(w.venue.liveOrder(A_CONTRACT)).toBeDefined();
  });

  it('a refused leg ends the deal with no order, and names the leg left changed', async () => {
    const w = world();
    w.venue.leverage.set(B_CONTRACT, '20');
    w.venue.nextLeverage.push('ok', 'reject:LEVERAGE_TOO_HIGH');
    await w.step(3);
    expect(w.venue.createCalls).toEqual([]);
    expect(w.venue.leverageCalls).toHaveLength(2);
    const pair = w.store.getPair(w.pairId)!;
    expect(pair.mode).toBe('DONE');
    expect(pair.leverage?.[1]).toMatchObject({ leg: 'B', state: 'failed', previous: '20' });
    expect(report(w).reason).toMatch(/leverage.*B.*LEVERAGE_TOO_HIGH/);
    expect(report(w).reason).toMatch(/A.*10.*3.*not restored/);
    expect(w.venue.leverage.get(A_CONTRACT)).toBe('3');
  });

  it('an unknown outcome is confirmed only by the read-back', async () => {
    const applied = world();
    applied.venue.nextLeverage.push('unknown-applied');
    await applied.step(3);
    expect(applied.store.getPair(applied.pairId)!.leverage?.[0].state).toBe('set');
    expect(applied.venue.createCalls).toHaveLength(1);

    const lost = world();
    lost.venue.nextLeverage.push('unknown-lost');
    await lost.step(3);
    expect(lost.venue.createCalls).toEqual([]);
    expect(lost.store.getPair(lost.pairId)!.mode).toBe('DONE');
    expect(report(lost).reason).toMatch(/leverage.*A.*reads back 10/);
  });

  it('names a leg the venue left at neither the old nor the target value', async () => {
    const w = world();
    w.venue.nextLeverage.push('unknown-lost');
    w.venue.setLeverage = async (contract, leverage) => {
      w.venue.leverageCalls.push({ contract, leverage });
      w.venue.leverage.set(contract, '7');
      return { kind: 'unknown', message: 'sim: partial' };
    };
    await w.step(3);
    expect(w.venue.createCalls).toEqual([]);
    expect(report(w).reason).toMatch(/reads back 7, not 3; left changed 10 → 7, not restored/);
  });

  it('a leverage it cannot read ends the deal without any mutation', async () => {
    const w = world();
    w.venue.leverageReadsFail = true;
    await w.step(3);
    expect(w.venue.leverageCalls).toEqual([]);
    expect(w.venue.createCalls).toEqual([]);
    expect(w.store.getPair(w.pairId)!.mode).toBe('DONE');
  });

  it('records the prior value before the call, so a crash mid-call keeps it', async () => {
    const w = world();
    w.venue.nextLeverage.push('crash');
    await expect(w.step()).rejects.toThrow(/sim crash/);
    expect(w.store.getPair(w.pairId)!.leverage?.[0]).toMatchObject({ state: 'pending', previous: '10' });
    await w.step(); // restart: reads 3, confirms with no second call
    expect(w.venue.leverageCalls).toHaveLength(1);
    expect(w.store.getPair(w.pairId)!.leverage?.[0]).toMatchObject({ state: 'set', previous: '10' });
  });

  it('a deal stopped before its leverage is set finishes without touching leverage', async () => {
    const w = world();
    w.store.updatePair(w.pairId, { mode: 'STOPPING' });
    await w.step(2);
    expect(w.venue.leverageCalls).toEqual([]);
    expect(w.store.getPair(w.pairId)!.mode).toBe('DONE');
  });

  it('a deal without targets owns no leverage and never touches it', async () => {
    const w = mkWorld({ deadlineInMs: null });
    await w.step();
    expect(w.store.getPair(w.pairId)!.leverage).toBeNull();
    expect(w.venue.leverageCalls).toEqual([]);
    expect(w.venue.createCalls).toHaveLength(1);
  });

  it('a passed deadline does not convert before leverage is set', async () => {
    const w = mkWorld({ leverage: targets, deadlineInMs: 0 });
    w.venue.leverage.set(A_CONTRACT, '10');
    w.venue.leverage.set(B_CONTRACT, '10');
    await w.step(2);
    expect(w.venue.createCalls).toEqual([]);
    expect(w.venue.leverageCalls).toHaveLength(2);
  });
});
