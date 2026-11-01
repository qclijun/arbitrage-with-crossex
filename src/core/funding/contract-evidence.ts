/** Exact reviewed products. Schema/ticker matches alone are never asset proof. */
interface EconomicProof { id: string; name: string; asset: string; product: string; }
const BINANCE_SPEC = 'https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information';
const OKX_SPEC = 'https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments';
const HL_SPEC = 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications';
const BYBIT_SPEC = 'https://www.bybit.com/en/learn/trading/trade-usdt-perpetual-futures';
const GATE_SPEC = 'https://www.gate.com/help/futures/perpetual/22147/calculation-of-position-value';
const LIGHTER_SPEC = 'https://docs.lighter.xyz/trading/contract-specifications';
// Reviewed 2026-10-30. Each exact product needs BOTH a venue economic-asset
// reference (named Bitcoin/Ethereum, linked to its project) and product/unit
// evidence corroborated with today's native instrument description.
const ECONOMIC_PROOFS: Record<string, EconomicProof> = {
  // Native HyperCore only: one unit of the underlying spot asset, USDC settlement.
  'HYPERLIQUID:BTC': { id: 'BTC', name: 'Bitcoin', asset: 'https://app.hyperliquid.xyz/trade/BTC', product: HL_SPEC },
  'HYPERLIQUID:ETH': { id: 'ETH', name: 'Ethereum', asset: 'https://app.hyperliquid.xyz/trade/ETH', product: HL_SPEC },
  'BINANCE:BTCUSDT': { id: 'BTC', name: 'Bitcoin', asset: 'https://www.binance.com/en/price/bitcoin', product: BINANCE_SPEC },
  'BINANCE:ETHUSDT': { id: 'ETH', name: 'Ethereum', asset: 'https://www.binance.com/en/price/ethereum', product: BINANCE_SPEC },
  'OKX:BTC-USDT-SWAP': { id: 'BTC', name: 'Bitcoin', asset: 'https://www.okx.com/price/bitcoin-btc', product: 'https://www.okx.com/en-au/help/i-perpetual-swaps' },
  'OKX:ETH-USDT-SWAP': { id: 'ETH', name: 'Ethereum', asset: 'https://www.okx.com/price/ethereum-eth', product: OKX_SPEC },
  'BYBIT:BTCUSDT': { id: 'BTC', name: 'Bitcoin', asset: 'https://www.bybit.com/en/coin-price/bitcoin/', product: BYBIT_SPEC },
  'BYBIT:ETHUSDT': { id: 'ETH', name: 'Ethereum', asset: 'https://www.bybit.com/en/coin-price/ethereum/', product: BYBIT_SPEC },
  // Reviewed 2026-11-01. Lighter names the asset on the trade page's Details tab.
  'GATE:BTC_USDT': { id: 'BTC', name: 'Bitcoin', asset: 'https://www.gate.com/price/bitcoin-btc', product: GATE_SPEC },
  'GATE:ETH_USDT': { id: 'ETH', name: 'Ethereum', asset: 'https://www.gate.com/price/ethereum-eth', product: GATE_SPEC },
  'LIGHTER:BTC': { id: 'BTC', name: 'Bitcoin', asset: 'https://app.lighter.xyz/trade/BTC', product: LIGHTER_SPEC },
  'LIGHTER:ETH': { id: 'ETH', name: 'Ethereum', asset: 'https://app.lighter.xyz/trade/ETH', product: LIGHTER_SPEC },
};
const FUNDING_SPECS: Record<string, string> = {
  BINANCE: 'https://www.binance.com/en/support/faq/detail/360033525031',
  ASTER: 'https://docs.asterdex.com/astherusex-orderbook-perp-guide/funding-rate',
  OKX: 'https://www.okx.com/en-gb/help/perps-funding-fee-mechanism',
  BYBIT: 'https://www.bybit.com/en/help-center/article/Funding-fee-calculation',
  HYPERLIQUID: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding',
  GATE: 'https://www.gate.com/help/futures/futures-logic/27569/funding-rate-and-funding-fee',
  // Paid on position × index price, not mark or another venue's oracle.
  LIGHTER: 'https://docs.lighter.xyz/trading/funding',
};
const RATE_BASIS: Record<string, string> = {
  HYPERLIQUID: 'linear-oracle-notional-fraction', LIGHTER: 'linear-index-notional-fraction',
};

/** Exact product encoding, corroborated with the official instrument record.
 * No case folding, alias replacement or multiplier normalization is permitted.
 */
export function nativeFundingId(venue: string, base: string, quote: string): string | null {
  if (['BINANCE', 'ASTER', 'BYBIT'].includes(venue) && quote === 'USDT') return `${base}USDT`;
  if (venue === 'OKX' && quote === 'USDT') return `${base}-USDT-SWAP`;
  if (venue === 'GATE' && quote === 'USDT') return `${base}_USDT`;
  if ((venue === 'HYPERLIQUID' || venue === 'LIGHTER') && quote === 'USDC' && !base.includes(':') && !base.includes('/')) return base;
  return null;
}

export function reviewedContractEvidence(venue: string, contractId: string, base: string, nativeEvidence: string) {
  const proof = ECONOMIC_PROOFS[`${venue}:${contractId}`];
  return {
    underlying: proof && proof.id === base ? { id: proof.id,
      evidence: `${proof.name}; ${proof.asset}; ${proof.product}; ${nativeEvidence}` } : null,
    // Formula proof is independent of economic-asset identity. HL's oracle
    // basis and Lighter's index basis stay distinct from CEX mark-price; cross-basis ranking is an estimate.
    rateBasis: FUNDING_SPECS[venue] ? {
      id: RATE_BASIS[venue] ?? 'linear-mark-notional-fraction',
      evidence: FUNDING_SPECS[venue]!,
    } : null,
  };
}
