# Opportunity screening

Run: synthetic-unknown
Taipei time: 2026-10-07T20:00:00+08:00
Data status: UNKNOWN

## Assumptions

{"notionalUsd": 10000, "top": 5, "entryMode": "maker-hedge", "borosEntry": "market", "primaryExitMode": "close", "maxAgeSeconds": 180, "maxSkewSeconds": 120, "clientRebatesAdded": false, "feeEvidence": "API without assumption warning"}

## Top candidates

### 1. ETH / USDT / markets 1 → 2

Maturity: 2026-11-13T08:00:00+08:00; remaining days: 36.50
Capital net APR: 125.00%; notional net APR: 5.00%; execution spread: 6.00%
Net profit: $50.00; total costs: $12.00; model capital: $400.00; holding return: 12.50%
Extra cost to erase net profit: $50.00
Maker leg: short; short OKX_ETH_USDT; long BINANCE_ETH_USDT
Costs: borosTakerFeeUsd: 2.00; borosSettleFeeUsd: 2.00; perpEntryFeesUsd: 2.00; perpEntrySlippageUsd: 2.00; perpExitFeesUsd: 2.00; perpExitSlippageUsd: 2.00; totalUsd: 12.00; annualizedApr: 1.00%
Capital model: borosShortImUsd: 100.00; borosLongImUsd: 100.00; perpShortImUsd: 100.00; perpLongImUsd: 100.00; shortLeverageMax: 100.00; longLeverageMax: 100.00
OI USD (reference): 100,000.00, 100,000.00
Ranked by model capital efficiency, then notional return and executable spread.
Absolute net profit and total API costs are shown over the remaining term.
Roll comparison: UNKNOWN (observation skew or missing comparison)

## Exclusions and evidence

- UNKNOWN: observation skew or missing comparison

## Limits

- Maker entry and modeled maker exit assume a fill at mid; resting orders are not guaranteed to fill.
- Model capital is the return denominator, not account funds or a safe budget.
- Book ok does not prove four-leg fills; OI is only market-size context.
- No client rebates added. Gas, borrowing interest and other unmodelled costs are excluded.
- Boros price impact is already in execution APR and is not deducted again.
- Roll avoids this period's perpetual exit costs; final exit can still cost money and future opportunities are not guaranteed.
