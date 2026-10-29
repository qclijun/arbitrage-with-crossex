/** Invented funding preview / receipt payloads (ticket 13) for UI tests; nothing here is a venue read. */
import type { FundingPreview, FundingReceipt } from '../api/fundingIntents';

const AT = Date.UTC(2026, 9, 1, 8, 2);

export function fundingPreview(over: Partial<FundingPreview> = {}, content: Partial<FundingPreview['content']> = {}): FundingPreview {
  return {
    previewId: 'p-1', readAt: AT, expiresAt: AT + 10_000, contentHash: 'h'.repeat(64), blockers: [], scenario: null,
    content: {
      candidateId: JSON.stringify(['BTC', 'BINANCE', 'BTCUSDT', 'BYBIT', 'BTCUSDT']), underlying: 'BTC', snapshotId: 'snap-1', cutoff: AT - 120_000,
      windowDays: 30,
      legs: {
        short: { venue: 'BINANCE', contractId: 'BTCUSDT', symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', role: 'hedge', leverage: '3' },
        long: { venue: 'BYBIT', contractId: 'BTCUSDT', symbol: 'BYBIT_FUTURE_BTC_USDT', side: 'BUY', role: 'maker', leverage: '5' },
      },
      quantityInput: '0.01050', quantity: '0.01', rounding: 'rounded down to the common lot step 0.001',
      makerPrice: '60000.1', timeoutSec: 300, onExpiry: 'convert-to-taker', holdDays: '14', currency: 'USDT',
      fees: { short: { maker: '0.0002', taker: '0.0005' }, long: { maker: '0.0001', taker: '0.00055' } },
      fx: 'none', borrow: 'not-applicable',
      amounts: { normalOneTime: '-0.42', conversionOneTime: '-0.63', daily: '0.07', normalHold: '0.56', conversionHold: '0.35' },
      payback: { normal: '6.0', conversion: '9.0' },
      warnings: ['maker-expiry-converts-remainder-to-taker', 'taker-ioc-has-no-price-or-cost-cap', 'one-leg-exposure-until-hedged',
        'trading-permission-inferred-from-signed-reads', 'risk-exempts-only-reconciled-floating-quantity'],
      ...content,
    },
    ...over,
  };
}

export function fundingReceipt(intentId: string, over: Partial<FundingReceipt['deal']> = {}): FundingReceipt {
  const preview = fundingPreview();
  return {
    intentId, dealId: `fund-${intentId}`, sliceId: `slice-${intentId}`, candidateId: preview.content.candidateId, acceptedAt: AT + 3_000,
    content: preview.content,
    deal: { mode: 'OPENING', deadlineAt: AT + 303_000, targetQty: '0.01', aFilled: '0', bFilled: '0', aReserved: '0', bReserved: '0',
      aUnfilled: '0.01', filledGap: '0', unhedged: '0', haltReason: null, leverage: null, report: null, orders: [], ...over },
  };
}
