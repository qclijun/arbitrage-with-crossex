/** Exact rational arithmetic over decimal strings, for money scenarios: nothing rounds until display. */
import { divideRounded, parseDecimal } from './history';

/** n / d with d > 0, in lowest terms. */
export interface Exact { n: bigint; d: bigint }

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return x || 1n;
};

function make(n: bigint, d: bigint): Exact {
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d < 0n ? -d : d);
  return { n: (sign * n) / g, d: (sign * d) / g };
}

export const ZERO: Exact = { n: 0n, d: 1n };

/** A plain decimal string, or null for anything else (exponents, blanks, NaN). */
export function exact(value: string): Exact | null {
  const parsed = parseDecimal(value);
  return parsed && make(parsed.coefficient, 10n ** BigInt(parsed.places));
}

export const add = (a: Exact, b: Exact): Exact => make(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Exact, b: Exact): Exact => make(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Exact, b: Exact): Exact => make(a.n * b.n, a.d * b.d);
/** `b` must not be zero. */
export const div = (a: Exact, b: Exact): Exact => make(a.n * b.d, a.d * b.n);
export const sign = (a: Exact): number => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0);
export const cmp = (a: Exact, b: Exact): number => sign(sub(a, b));
export const sum = (values: Exact[]): Exact => values.reduce(add, ZERO);

const PLACES = 18;

/** Display form: at most 18 decimals, half away from zero, trailing zeros dropped. */
export function decimal(value: Exact): string {
  return divideRounded(value.n * 10n ** BigInt(PLACES), value.d, PLACES);
}
