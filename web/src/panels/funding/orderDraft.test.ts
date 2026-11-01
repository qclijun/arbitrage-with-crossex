import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT, draftErrors, leverageFor, quantityFor } from './orderDraft';

describe('quantityFor', () => {
  it('floors the notional to four significant figures, snapping exact quotients', () => {
    expect(quantityFor(10_000, 64_000)).toBe('0.1562');
    expect(quantityFor(10_000, 10_000 / 0.57)).toBe('0.57');
    expect(quantityFor(10_000, 10_000 / 2.01)).toBe('2.01');
    expect(quantityFor(10_000, 4000)).toBe('2.5');
    expect(quantityFor(10_000, 0.001)).toBe('10000000');
  });

  it('caps at twelve decimals and refuses an unpriceable quantity', () => {
    expect(quantityFor(10_000, 1e15)).toBe('0.00000000001');
    expect(quantityFor(10_000, 1e17)).toBeNull();
    for (const bad of [undefined, 0, -1, NaN, Infinity]) expect(quantityFor(10_000, bad)).toBeNull();
  });
});

describe('leverageFor', () => {
  it('takes the whole max leverage the field accepts, else nothing', () => {
    expect(leverageFor(50.5)).toBe('50');
    expect(leverageFor(125)).toBe('125');
    expect(leverageFor(1)).toBe('1');
    for (const bad of [undefined, 0, 0.5, 1000, NaN]) expect(leverageFor(bad)).toBeNull();
  });
});

describe('DEFAULT_DRAFT', () => {
  it('needs only quantity and the two leverages', () => {
    expect(Object.keys(draftErrors(DEFAULT_DRAFT)).sort()).toEqual(['leverageLong', 'leverageShort', 'quantity']);
  });
});
