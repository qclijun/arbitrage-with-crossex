const SCALE18 = 10n ** 18n;

/** Parse a plain decimal string without dropping any of Boros' 18 places. */
export function parseDecimal18(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, integer, rawFraction = ''] = m;
  const fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > 18) return null;
  const amount = BigInt(integer) * SCALE18 + BigInt(fraction.padEnd(18, '0') || '0');
  return sign === '-' ? -amount : amount;
}

export function formatDecimal18(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const integer = abs / SCALE18;
  const fraction = (abs % SCALE18).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${sign}${integer}.${fraction}` : `${sign}${integer}`;
}

/** Decode a Boros wire integer, whose unit is 1e-18 of a token. */
export function rawInteger18ToDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  return formatDecimal18(BigInt(value));
}
