/** Compare supported loopback aliases without changing persisted config hashes. */
export function sameRiskTerminal(a: unknown, b: unknown): boolean {
  const port = (value: unknown): string | null => {
    if (typeof value !== 'string' || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(value)) return null;
    try { return new URL(value).port || '80'; } catch { return null; }
  };
  const expected = port(a);
  return expected !== null && expected === port(b);
}
