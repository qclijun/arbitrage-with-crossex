export * from '../../../src/core/risk';

export function formatRiskValue(value: unknown, unit: string): string {
  if (value === null || value === undefined) return 'UNKNOWN';
  if (typeof value !== 'number') return String(value);
  if (unit === 'unix seconds') return formatRiskTime(value);
  if (unit === 'count') return String(value);
  const digits = unit.startsWith('ETH') ? 6 : ['ratio', 'APR fraction', 'ratio lower bound'].includes(unit) ? 4 : 2;
  return value !== 0 && Math.abs(value) < 10 ** -digits ? value.toExponential(2) : value.toFixed(digits);
}

export function formatRiskTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'UNKNOWN';
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'UNKNOWN';
}
