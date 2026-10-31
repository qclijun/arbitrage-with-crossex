# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: an expert operator running a live delta-neutral funding-rate desk with real funds. They hold several 4-leg books at once (for example ETH and BTC pairs across OKX and Hyperliquid), roll Boros positions before maturity, rebalance perps, and run daily risk checks. They know the domain deeply and want density, precision, and speed rather than explanation.

Secondary: outside traders who install Pendle's open-source build on their own macOS or Windows machine with their own Gate.io keys. Design for the expert first, but never in a way that makes the tool unsafe or opaque for a careful newcomer.

## Product Purpose

A local trading terminal for delta-neutral funding-rate arbitrage across Pendle's Boros and Gate's CrossEx. Two Boros legs lock a fixed funding rate until maturity; two CrossEx perp legs (long one venue, short another) cancel the floating funding between them. The locked spread is the return. The terminal finds viable pairs, prices them net of every cost, opens all four legs in the right order, and tracks each position as one strategy.

Success means:

- **Never unhedged.** The operator always knows their exposure, unhedged legs, funding gaps, and over-coverage. Recovery is one obvious action.
- **Honest net yield.** Opportunities are ranked net of fees, entry mode, and perp exit, with those assumptions on screen. No number reads as a guaranteed return.
- **Fast execution.** Opening, rebalancing, and rolling take few steps and get good fills.
- **Trust by audit.** Trust comes from transparency: local-only operation, no telemetry, a pinned and verifiable commit. It does not come from branding.

## Positioning

One collateral pool on CrossEx backs perps on several venues (BINANCE, BYBIT, GATE, OKX, KRAKEN, HYPERLIQUID, LIGHTER), paired with Boros fixed-rate legs and handled as one 4-leg strategy. The deal engine runs server-side on the user's own machine, so executions survive a closed tab and keys never leave the machine except inside signed requests to Gate.io.

## Operating Context

- Runs as a background service at `http://localhost:6688`, opened in a wide desktop browser and left open while deals are live. The machine must stay on while a deal is open.
- Main surfaces: Opportunities (ranked pairs, adjustable cost assumptions, waterfall), Monitoring (margin strip, balances, positions as 4-leg strategy cards, trades with per-fill fees, open orders, fee rates), Trading (guided two-step lock-then-hedge flow, order, pair and basket tickets, a review modal with hold-to-confirm), plus rebalance, transfer, rollover, risk, and settings.
- Daily rituals around the UI: risk checks (`/check-risk`, `docs/DAILY-RISK-CHECKLIST.zh-CN.md`), rollover planning near Boros maturities, and opportunity screening scripts under `scripts/`.
- Domain terms come from `GLOSSARY.md` (strategy slice, unattributed position, funding gap, funding over-coverage, perp price net exposure, rollover, atomic rollover, execution feasibility). UI work uses those terms precisely.

## Capabilities and Constraints

- Real orders with real funds. Pair legs are linked; if exactly one leg fills, a red UNHEDGED banner offers one-click remediation (complete the missing leg or unwind the filled one).
- Gate order-state strings are undocumented. Unknown states render verbatim and stay quarantined. The UI must never normalize or hide them.
- Money and quantities are decimal strings end to end. Sizing follows the market's collateral: ETH and BTC markets quote in the coin, USDT and USDC markets in dollars.
- Confirmations are hold-to-press and disable when previews go stale.
- Server binds to `127.0.0.1` with Host/Origin checks and mandatory `/api` token auth. The only outbound hosts are a short, fixed list.
- Desktop only. Mobile layouts are out of scope.
- UI copy is English only. Chinese stays in docs and the glossary.
- Stack: React 18, Vite, Tailwind, react-query, self-hosted Inter (works offline).

## Brand Commitments

- Open-source tool published by Pendle, labelled "Experimental, use at your own risks". The disclaimer gate and its wording stay.
- UI work stays aligned with the Boros design-system tokens and the Pendle open-source identity (`BorosLogo`, `BrandMark`, the `ink` token names in `web/tailwind.config.cjs`).
- Nothing in the UI may imply affiliation, sponsorship, or endorsement by Gate.io or other venues, or give financial advice.

## Evidence on Hand

- User guides: `docs/USER_GUIDE.md`, `docs/USER_GUIDE.zh-CN.md`.
- Screenshots: `docs/CurrentPosition.png`, `docs/OpportunitiesDetails.png`, `docs/Assumptions.png`, `docs/RepegToTouch.png`.
- Disclaimer: `docs/DISCLAIMER.md`.
- No testimonials, user counts, performance track record, or audited yield figures exist. Do not invent them.

## Product Principles

1. **Exposure before opportunity.** Show hedge state, funding gaps, and risk before yield. An unhedged or unattributed position outranks any opportunity on screen.
2. **Show the assumption behind every number.** Net yield, fill estimates, and projections carry their cost and size assumptions with them. Historical spread is never shown as a locked return.
3. **Render venue truth verbatim.** Unknown states, partial fills, and mismatches appear as they are. Never round them into a clean story.
4. **Expert speed, guarded by friction where it matters.** Dense, fast surfaces for the operator. Deliberate friction (hold-to-confirm, stale-preview lockout) only on irreversible wire actions.
5. **Correct for every reachable case.** Part fills, part holds, and mixed books are first-class states in the UI, not edge cases.
