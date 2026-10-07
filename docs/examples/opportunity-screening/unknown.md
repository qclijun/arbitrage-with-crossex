# Opportunity screening

Run: synthetic-unknown
Taipei time: 2026-10-07T20:00:00+08:00
Data status: UNKNOWN

## Assumptions

{"notionalUsd": 10000, "top": 5, "entryMode": "maker-hedge", "borosEntry": "market", "primaryExitMode": "close", "maxAgeSeconds": 180, "maxSkewSeconds": 120, "clientRebatesAdded": false, "feeEvidence": "UNKNOWN", "maxMarketAgeSeconds": 180, "maxStaticAgeSeconds": 600, "skewBasis": "marketData"}

## Freshness evidence

- close Market data: VALID; observed 2026-10-07T20:00:00+08:00; age 0.00 seconds; limit 180.00 seconds
- close Static data: VALID; observed 2026-10-07T20:00:00+08:00; age 0.00 seconds; limit 600.00 seconds
- roll Market data: VALID; observed 2026-10-07T20:00:00+08:00; age 0.00 seconds; limit 180.00 seconds
- roll Static data: VALID; observed 2026-10-07T20:00:00+08:00; age 0.00 seconds; limit 600.00 seconds

## Top candidates

No qualifying candidates. Top list is not padded.
## Exclusions and evidence

- [close] ETH / USDT / maturity 2026-11-13T08:00:00+08:00 / markets 1 → 2 / short OKX_ETH_USDT / long BINANCE_ETH_USDT — UNKNOWN: assumed fee schedule: reference only
  Reference only values: grossSpreadApr: 8.00%; execSpreadApr: 6.00%; borosImpactApr: 2.00%; capitalUsd: 400.00; netFixedApr: 5.00%; netFixedAprOnCapital: 125.00%; effectiveLeverage: 25.00; estProfitUsd: 50.00; secondsToMaturity: 3,153,600.00
  Reference only costs: borosTakerFeeUsd: 2.00; borosSettleFeeUsd: 2.00; perpEntryFeesUsd: 2.00; perpEntrySlippageUsd: 2.00; perpExitFeesUsd: 2.00; perpExitSlippageUsd: 2.00; totalUsd: 12.00; annualizedApr: 1.00%
- UNKNOWN: assumed fee schedule: reference only

## Limits

- Maker entry and modeled maker exit assume a fill at mid; resting orders are not guaranteed to fill.
- Model capital is the return denominator, not account funds or a safe budget.
- Book ok does not prove four-leg fills; OI is only market-size context.
- No client rebates added. Gas, borrowing interest and other unmodelled costs are excluded.
- Boros price impact is already in execution APR and is not deducted again.
- Roll avoids this period's perpetual exit costs; final exit can still cost money and future opportunities are not guaranteed.
