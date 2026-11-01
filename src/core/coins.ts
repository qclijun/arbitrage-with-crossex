export const SUPPORTED_COINS = ['ETH', 'HYPE', 'BTC'] as const;

export const COIN_NOT_SUPPORTED_TEXT = 'This coin is not supported. Pick ETH, HYPE or BTC.';

export type SupportedCoin = (typeof SUPPORTED_COINS)[number];

export function isSupportedCoin(base: string): boolean {
  const upper = base.toUpperCase();
  return SUPPORTED_COINS.some((coin) => coin === upper);
}

/**
 * Assets the funding spreads page collects settled history for, ranks and
 * lists. Every other asset's contracts are left out, so the history refresher
 * stays inside venue rate limits. Extend here.
 */
export const FUNDING_ASSETS: readonly string[] = ['ETH', 'BTC'];
