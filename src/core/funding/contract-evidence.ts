/** Exact reviewed products. Schema/ticker matches alone are never asset proof. */
interface EconomicProof { id: string; name: string; asset: string; product: string; }
const BINANCE_SPEC = 'https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information';
const OKX_SPEC = 'https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments';
const BYBIT_SPEC = 'https://www.bybit.com/en/learn/trading/trade-usdt-perpetual-futures';
// Reviewed 2026-10-30. Each exact product needs BOTH a venue economic-asset
// reference (named Bitcoin/Ethereum, linked to its project) and product/unit
// evidence corroborated with today's native instrument description.
const ECONOMIC_PROOFS: Record<string, EconomicProof> = {
  'BINANCE:BTCUSDT': { id: 'BTC', name: 'Bitcoin', asset: 'https://www.binance.com/en/price/bitcoin', product: BINANCE_SPEC },
  'BINANCE:ETHUSDT': { id: 'ETH', name: 'Ethereum', asset: 'https://www.binance.com/en/price/ethereum', product: BINANCE_SPEC },
  'OKX:BTC-USDT-SWAP': { id: 'BTC', name: 'Bitcoin', asset: 'https://www.okx.com/price/bitcoin-btc', product: 'https://www.okx.com/en-au/help/i-perpetual-swaps' },
  'OKX:ETH-USDT-SWAP': { id: 'ETH', name: 'Ethereum', asset: 'https://www.okx.com/price/ethereum-eth', product: OKX_SPEC },
  'BYBIT:BTCUSDT': { id: 'BTC', name: 'Bitcoin', asset: 'https://www.bybit.com/en/coin-price/bitcoin/', product: BYBIT_SPEC },
  'BYBIT:ETHUSDT': { id: 'ETH', name: 'Ethereum', asset: 'https://www.bybit.com/en/coin-price/ethereum/', product: BYBIT_SPEC },
};
const FUNDING_SPECS: Record<string, string> = {
  BINANCE: 'https://www.binance.com/en/support/faq/detail/360033525031',
  ASTER: 'https://docs.asterdex.com/astherusex-orderbook-perp-guide/funding-rate',
  OKX: 'https://www.okx.com/en-gb/help/perps-funding-fee-mechanism',
  BYBIT: 'https://www.bybit.com/en/help-center/article/Funding-fee-calculation',
  HYPERLIQUID: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding',
};

/** Exact product encoding, corroborated with the official instrument record.
 * No case folding, alias replacement or multiplier normalization is permitted.
 */
export function nativeFundingId(venue: string, base: string, quote: string): string | null {
  if (['BINANCE', 'ASTER', 'BYBIT'].includes(venue) && quote === 'USDT') return `${base}USDT`;
  if (venue === 'OKX' && quote === 'USDT') return `${base}-USDT-SWAP`;
  if (venue === 'HYPERLIQUID' && quote === 'USDC' && !base.includes(':')) return base;
  return null;
}

export function reviewedContractEvidence(venue: string, contractId: string, base: string, nativeEvidence: string) {
  const proof = ECONOMIC_PROOFS[`${venue}:${contractId}`];
  return {
    underlying: proof && proof.id === base ? { id: proof.id,
      evidence: `${proof.name}; ${proof.asset}; ${proof.product}; ${nativeEvidence}` } : null,
    // Formula proof is independent of economic-asset identity. HL's oracle
    // basis must never be silently paired with the CEX mark-price basis.
    rateBasis: FUNDING_SPECS[venue] ? {
      id: venue === 'HYPERLIQUID' ? 'linear-oracle-notional-fraction' : 'linear-mark-notional-fraction',
      evidence: FUNDING_SPECS[venue]!,
    } : null,
  };
}
