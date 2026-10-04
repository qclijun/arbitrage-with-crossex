# Risk 页面：复用终端账户、数据和刷新机制

Label: ready-for-agent
Status: ready
Assignee: unassigned

## Problem Statement

交易者需要在终端集中完成风险巡检：发现保证金不足、清算距离缩小、结算缓冲下降、对冲偏差、交易残留和临近到期等异常，并知道指标值、阈值、原因与下一步应检查什么。

现有账户状态栏、Collateral 和 Positions 已提供部分数据与计算，但没有覆盖独立风险监控的完整检查视图。切换页面或阅读命令行报告增加巡检成本；缺失证据、过期数据和条件模型也容易被误读成当前账户安全。

## Solution

在终端现有标签导航中增加只读 Risk 页面。它沿用终端账户上下文、数据查询、缓存和刷新机制，优先使用现有领域计算，将当前启用的风险检查汇总为告警概览、关键指标和检查详情。

顶部突出 CRITICAL、WARNING 与 UNKNOWN；详情展示指标、单位、阈值、来源、时间、异常原因和建议动作。自动数据不足时补充必要的只读适配，人工证据或不可验证数据保持 UNKNOWN。页面刷新不启动 Python 采集进程，不改变后台通知、去抖或交易行为。

## User Stories

1. As a terminal trader, I want a Risk tab beside the existing sections, so that I can inspect risk without leaving the terminal.
2. As a terminal trader, I want Risk to use the current Gate account, so that its account figures match the terminal.
3. As a terminal trader, I want Risk to follow the selected Boros wallet and the terminal's supported subaccount, so that I inspect the intended collateral and positions.
4. As a terminal trader, I want wallet and credential changes to invalidate incompatible risk data, so that I never see another account's result as my current result.
5. As a terminal trader, I want clear labels for account-wide and ETH strategy checks, so that I understand each measurement's scope.
6. As a terminal trader, I want Risk to reuse the terminal's refresh behavior, so that its freshness and loading behavior are familiar.
7. As a terminal trader, I want existing queries and cached results to be shared, so that opening Risk avoids redundant collection.
8. As a terminal trader, I want hidden-page polling to follow the existing tab policy, so that inactive Risk adds no independent polling loop.
9. As a terminal trader, I want separate counts of CRITICAL, WARNING and UNKNOWN, so that missing evidence cannot disappear inside a healthy summary.
10. As a terminal trader, I want the most severe checks shown first, so that I can prioritize investigation.
11. As a terminal trader, I want Gate initial-margin and maintenance-margin checks, so that I distinguish initial coverage from liquidation-related health.
12. As a terminal trader, I want the terminal's modeled liquidation distance and assumptions, so that I assess a conditional price move without mistaking it for an official liquidation price.
13. As a terminal trader, I want stablecoin liabilities and estimated current daily borrowing interest, so that I see the cost and financing exposure of the current account.
14. As a terminal trader, I want ETH Boros cross-pool coverage and available collateral, so that I assess the pool that supports the monitored strategy.
15. As a terminal trader, I want adverse rate spread and rate mark-to-market, so that I can investigate erosion of the funding hedge.
16. As a terminal trader, I want complete past-24-hour net ETH settlements and buffer runway, so that I understand recent cash outflow and its limits as a historical estimate.
17. As a terminal trader, I want perpetual mark spread and basis PnL, so that I can distinguish venue price exposure from funding exposure.
18. As a terminal trader, I want hedge quantity, direction, market and maturity checks, so that I detect mismatched legs.
19. As a terminal trader, I want unexpected changes measured against a verified baseline, so that a missing baseline is not silently replaced with the current position.
20. As a terminal trader, I want unhedged execution, halted deals and aged pending orders, so that I can investigate incomplete execution.
21. As a terminal trader, I want days to maturity and relevant rollover checks, so that I can prepare for funding exposure changes.
22. As a terminal trader, I want rollover checks paused only when complete positions prove a distant maturity, so that missing positions cannot suppress a warning.
23. As a terminal trader, I want agent approval, expiry and gas checks, so that I can assess whether the existing account can operate normally.
24. As a terminal trader, I want collector health, heartbeat and notification-delivery evidence shown separately, so that an open browser is not mistaken for a running monitor.
25. As a terminal trader, I want independent stablecoin quotes and reviewed custody, protocol and oracle evidence, so that unsupported assumptions remain visible.
26. As a terminal trader, I want the full set of enabled checks available in details, so that less common risks are not omitted from the page.
27. As a terminal trader, I want each check's value, unit, threshold, reason and recommended action, so that I can understand an alert without reading source code.
28. As a terminal trader, I want evidence times and stale, partial or failed-read indicators, so that I can judge the reliability of each result.
29. As a terminal trader, I want last successful values visibly marked as historical after a read fails, so that useful context does not imply present safety.
30. As a terminal trader, I want missing or invalid evidence to remain UNKNOWN, so that absent data never becomes zero or OK.
31. As a terminal trader, I want a previously verified CRITICAL to remain visible when its triggering metric becomes unverifiable, so that a failed read cannot masquerade as recovery.
32. As a terminal trader, I want known severe conditions to remain visible even when other required metrics are missing, so that partial coverage does not hide a measured danger.
33. As a terminal trader, I want usable empty, loading and unsupported-scope states, so that I can distinguish no verified positions from failed collection.
34. As a terminal trader, I want keyboard-accessible tabs, readable labels and status text beyond color, so that I can use Risk consistently with the terminal.
35. As a terminal trader, I want Risk to display information without sending notifications or executing actions, so that browsing cannot affect the running strategy.

## Implementation Decisions

### Scope and ownership

- Add a Risk panel through the existing tab registry, selected-tab persistence and supported tab deep-link behavior. Reuse terminal layout and accessible panel semantics.
- Use the terminal's configured Gate account and selected Boros address. Use the same validated subaccount that each existing source supports; a source fixed to subaccount zero cannot establish coverage for another subaccount.
- Account-wide Gate checks remain account-wide. ETH-named checks apply to the script-defined ETH strategy and ETH collateral pool; they must not silently aggregate other assets or borrow another pool's safety buffer.
- The current rule catalog has 32 defined checks, 29 enabled checks and 61 metric IDs referenced by enabled checks. Enumerate enabled checks from the catalog at runtime rather than hardcoding those counts.
- Three currently disabled checks remain excluded: total ETH collateral exposure, ETH downside stress loss and executable exit cost. Changes to their enablement are outside this feature.
- Keep the rule catalog and metric contracts authoritative for IDs, labels, units, accepted types, evidence age, threshold predicates and recommended actions. Reuse applicable existing threshold overrides only when their scope is verified; otherwise use catalog defaults.
- Build a small Risk data adapter and a presentation-independent rule evaluator. The adapter consumes existing terminal snapshots; financial calculations stay in the responsible terminal/domain model. Reuse existing collateral, interest, exposure and liquidation calculations rather than implementing alternate formulas in the page.
- Where a calculation exists only in the Python monitor, implement the minimum equivalent in the responsible domain layer, using the same rule and metric contracts and synthetic parity fixtures. Do not migrate the whole monitor or add a Python process bridge for page refresh.
- Risk's display evaluation is independent of notification scheduling. Reading the page must not update the monitor's files, service counters, notification queue, notification debounce or alert acknowledgment state.

### Data reuse and refresh

- Reuse existing query hooks and exact query keys for the same inputs. Share the query client and backend cache; avoid a second query namespace or aggregate endpoint that independently re-fetches already available account data.
- Keep each reused source's existing cadence and freshness flags. Current examples are account 5 seconds, positions/open orders 4 seconds, asset view 30 seconds, Boros collateral 15 seconds and engine alerts 10 seconds; those values remain owned by the existing query layer.
- Follow current initial-load, cached-result, return-to-tab, focus and inactive-tab behavior. Existing global observers may continue polling while Risk is hidden; do not add a Risk-specific timer to override them.
- Switching to Risk may cause the existing query machinery to fetch where its normal policy requires it. It must not force every source to bypass cache or trigger a full monitor collection.
- Supplemental metadata/evidence reads use the same query and cache conventions, with one active-page read on the existing slow-risk/asset cadence. Reuse an existing owner or cached read where available; no new user-facing refresh configuration is needed.
- Reuse the asset-view position snapshot and incremental settlement ledger. Do not request an extra full-history window merely to recompute values already available. Extend the existing read-only data owner only for genuinely absent evidence.
- Shared financial inputs should retain source failure, stale and coverage signals through the data layer. A successful envelope timestamp or browser query update time is not upstream market time.
- Supplemental responses must carry enough scope and evidence metadata to validate the configured account, address, subaccount, collateral pool, source and observation time. They expose only approved metrics and operational metadata, never secrets or raw account payloads.
- A legacy monitor report without verifiable scope is not accepted as current-account evidence. The feature uses terminal data first; any monitor-only evidence is read through a validated, scope-bound adapter.

### Enabled-check source map

Each row accounts for every metric referenced by that check. Existing terminal sources are preferred; the last column defines the required supplement or explicit UNKNOWN condition.

| Check ID | Referenced metrics | Reuse source and required evidence |
|---|---|---|
| `boros.im_coverage` | `boros.im_coverage` | Selected ETH cross-pool collateral's existing initial-margin coverage. |
| `boros.mm_health_ratio` | `boros.mm_health_ratio` | The same pool's existing maintenance-margin coverage; no USD conversion required. |
| `boros.available_eth` | `boros.available_eth` | The same pool's available initial collateral in ETH, using the terminal's validated unit conversion. |
| `boros.adverse_spread_pp` | `boros.adverse_spread_pp`, `boros.rate_mtm_usd`, `boros.mtm_loss_equity_ratio` | Existing ETH asset-view legs and MTM plus selected-pool equity; verify market/venue identity, directions, prices and complete positions. |
| `boros.settlement_net_24h_eth` | `boros.settlement_net_24h_eth`, `boros.buffer_runway_days` | Existing incremental settlement ledger plus the selected pool's available ETH; supplement raw net-ETH/window coverage only where absent from the public view. |
| `gate.im_coverage` | `gate.im_coverage` | Existing account margin balance and initial-margin model. |
| `gate.mm_health_ratio` | `gate.mm_health_ratio` | Existing account maintenance-margin model; display coverage rather than confusing it with the reciprocal usage percentage. |
| `gate.liability_usdt` | `gate.liability_usdt`, `gate.liability_usdc`, `gate.interest_daily_usd` | Existing account assets and current-interest buckets; match liabilities to venue/coin buckets and preserve incomplete rates as UNKNOWN. |
| `gate.liquidation_distance_pct` | `gate.liquidation_distance_pct` | Existing terminal liquidation model and risk tiers, with its original assumptions and complete exposure gate. |
| `basis.mark_spread_usd_per_eth` | `basis.mark_spread_usd_per_eth`, `basis.pnl_usd`, `basis.loss_profit_ratio` | Existing exact ETH perpetual legs and price/PnL data. The profit denominator requires verified opening time, fees and matching funding legs; otherwise the ratio is UNKNOWN. |
| `hedge.perp_net_eth` | `hedge.perp_net_eth` | Existing exposure normalization, exact contracts and verified strategy membership/baseline; no symbol-substring substitution. |
| `hedge.hl_size_gap_eth` | `hedge.hl_size_gap_eth`, `hedge.binance_size_gap_eth`, `hedge.direction_match` | Existing signed venue quantities and Boros asset legs, with contract multipliers and side semantics retained. |
| `hedge.maturity_match` | `hedge.maturity_match`, `hedge.market_identity_match` | Existing Boros market metadata and verified strategy baseline. Missing or ambiguous baseline is UNKNOWN. |
| `execution.unhedged_eth` | `execution.unhedged_eth`, `execution.halted_count`, `execution.pending_age_s` | Existing deal projections, engine alerts and open orders. Use explicit pending/quarantine and execution reports; missing projections cannot establish zero. |
| `positions.unexpected_change_eth` | `positions.unexpected_change_eth` | Current complete positions versus an existing verified, scope-matching four-leg baseline; do not create a baseline from the first page visit. |
| `rollover.days_to_maturity` | `rollover.days_to_maturity` | Existing actual market maturities and complete current positions, using the glossary's funding exposure concepts. |
| `rollover.next_net_apr` | `rollover.next_net_apr`, `rollover.depth_coverage_ratio` | Existing opportunity/rollover pricing for the actual size, matching venues and later maturity; reuse a matching quote only. Never replace notional APR with capital APR or a depth-backed quote with mid price. |
| `rollover.incremental_margin_usd` | `rollover.incremental_margin_usd`, `rollover.post_roll_coverage` | Existing verified rollover margin evaluation if it measures old/new coexistence. Otherwise retain UNKNOWN and require fresh scoped evidence. |
| `rollover.uncovered_funding_seconds` | `rollover.uncovered_funding_seconds`, `rollover.uncovered_funding_eth` | Existing actual perpetual and live Boros positions plus a verified funding-gap start. Missing duration history remains UNKNOWN; opening Risk must not reset the start clock. |
| `market.trading_status` | `market.trading_status`, `market.last_status_verified_at` | Existing complete authoritative market-status evidence if available, otherwise scoped external evidence. A filtered opportunity list does not establish normal trading. |
| `data.age_seconds` | `data.age_seconds`, `data.stale`, `data.coverage_complete` | Existing upstream timestamps, stale marks, read errors and history/position coverage fields. Successful HTTP alone cannot prove freshness or completeness. |
| `service.http_ok` | `service.http_ok`, `service.consecutive_failures`, `service.last_success_age_s` | Terminal health plus independent collector completion/counter evidence where required by the check. Browser fetch successes/failures do not replace collector state. |
| `agent.approval` | `agent.approval`, `agent.expiry_days` | Existing delegated-agent status/expiry, only for its configured root and supported subaccount. Another selected wallet cannot inherit that approval. |
| `agent.gas_balance_usd` | `agent.gas_balance_usd` | Existing gas-balance reader/cache with matching account scope; supplement its read-only exposure if unavailable to the page. Gas is separate from collateral. |
| `monitor.heartbeat_age_s` | `monitor.heartbeat_age_s`, `monitor.last_complete_run_at` | Validated producer heartbeat/last-complete evidence via a minimal read-only operational adapter. Opening Risk is not a heartbeat. |
| `notify.last_success_at` | `notify.last_success_at`, `notify.pending_count`, `notify.failure_streak` | Confirmed monitor notification state via the same scoped adapter. Pendle managed connection status is not proof of checklist delivery. |
| `stablecoin.usdt_usd` | `stablecoin.usdt_usd`, `stablecoin.usdc_usd`, `stablecoin.source_age_s`, `stablecoin.usdt_deviation`, `stablecoin.usdc_deviation` | Independent, timestamped USD quote evidence. The terminal's valuation assumption of USD parity is not a measured quote. |
| `custody.incident_status` | `custody.incident_status`, `custody.review_age_h`, `custody.withdrawal_status` | Existing fresh reviewed/scoped evidence; missing manual reviews stay UNKNOWN. A clear review does not prove custody safety. |
| `protocol.incident_status` | `protocol.incident_status`, `protocol.review_age_h`, `oracle.settlement_lag_s` | Existing fresh official review and oracle/settlement-progress evidence; supplement only verified scoped data. |

### Metric and status contracts

- Normalized metric evidence includes metric ID, value or null, contract unit/type, source, applicable account scope, observation time, coverage/validation status, and an evidence reference/expiry where required. Convert timestamp units at the boundary and use an explicit evaluation clock.
- Reject numeric strings, booleans as numbers, non-finite numbers, invalid enum values, wrong units, negative/fractional counts, future timestamps and expired evidence. An unavailable measurement is null with a reason; zero requires affirmative complete evidence.
- Each check exposes its ID, label/risk group, status, referenced metric evidence, effective thresholds, coverage flag, reason and recommended action. UI summaries are derived from these checks rather than from a second set of heuristics.
- Apply the catalog's strict comparison operators and maximum triggered severity. A missing required metric yields UNKNOWN unless a measured condition establishes WARNING/CRITICAL; coverage remains incomplete even when a severe condition is known.
- Preserve the monitor's recovery hysteresis and previously verified critical-trigger behavior. Keep display state isolated by current credential identity, address, supported subaccount and strategy scope; it must never write the standalone monitor's notification or risk state.
- A previously verified CRITICAL stays CRITICAL when the triggering metric becomes unverifiable, with that reason displayed. Recovery requires valid evidence satisfying the existing recovery boundary. In a new scope without historical evidence, start from current measurements/UNKNOWN, never an inherited OK or CRITICAL.
- Use existing verified history/baselines for temporal checks. If only page-local observations are available, show their actual coverage start and do not present them as uninterrupted collector history.
- Suppress out-of-window rollover checks only when complete current Boros positions for the relevant subaccount and valid maturities prove at least 14 days remaining. Mark them paused separately; do not count them as OK or leave them indistinguishable from missing checks.
- Complete settlement coverage must span the full rolling interval `(now − 24 hours, now]` for the selected ETH cross pool, including closed markets. Sum net ETH settlement events once; retain fee and duplicate-event semantics. Incomplete pages, conflicts or malformed events yield UNKNOWN; a verified empty window is zero.
- Buffer runway is available ETH divided by past-day net outflow, a historical management estimate. With verified zero/positive net flow, explain that the current window establishes no finite outflow runway; do not present an internal large-number sentinel as a guaranteed forecast.
- Protect account isolation using the existing query keys and response identity. Credential/address changes clear incompatible derived state. A source whose wallet, subaccount or collateral pool cannot be verified cannot be combined with current-account evidence.
- Distinguish service/read availability from market-data age and completeness. A fresh partial read does not become OK simply because the page's clock advanced. Retain old values only as explicitly historical context.

### Presentation

- Show account scope and source freshness near the page heading, followed by severity counts and key risk values. Use CRITICAL, WARNING, UNKNOWN and OK text in addition to existing terminal status colors.
- Prioritize margin/liquidation, settlement buffer, hedge/execution and maturity risk. Keep every enabled check accessible in the details view without requiring a separate page.
- Show each metric's unit and threshold alongside its value. Keep full precision in source/evaluation data and use the terminal's established unit-aware formatting for display; ratios, APR fractions and percentage points must remain distinct.
- Show current versus historical values, missing evidence and paused checks explicitly. An all-OK summary requires complete applicable evidence; neither `coverageComplete` nor a fresh review is a promise of safety.
- Recommended actions are explanatory text. This feature provides no new trading, funding, approval, transfer or notification action controls.

## Testing Decisions

- The primary acceptance seam is the rendered terminal/Risk page with the existing query client and mocked API responses. Assert visible user behavior rather than component internals or one test per helper.
- Extend the established hidden-tab/return-to-tab request-count tests to prove Risk follows existing polling and reuses compatible query keys. Do not require absolutely zero hidden requests from existing global observers, and do not assert an unrealistically identical snapshot time across differently paced sources.
- Use the existing collateral-page prior art for loading, failed initial reads, background errors with historical data and wallet mismatch. Add transitions between two wallets and credential invalidation; assert no old balances or derived severity leak to the new scope.
- For necessary supplemental reads, extend existing server injection/stub tests. Prove reuse of account/collateral/ledger cache owners, valid scope, partial-read handling and metadata preservation. Verify authentication/host protections apply and responses omit secrets and raw state.
- Use synthetic normalized evidence as the narrow rule-evaluation seam. Cover below/on/above numeric boundaries, all supported comparison operators, severe-known plus missing-other evidence, invalid types, expiry/future time, hysteresis and unresolved critical triggers.
- Use common synthetic scenarios against the current Python evaluation and the new terminal rule adapter to prove parity in thresholds, severity, units and applicable-check decisions. Assert financial results and visible statuses, not private implementation shape.
- Verify all currently enabled checks and their referenced metric IDs are accounted for. Disabled checks stay omitted, and distant-maturity checks become paused only with the exact complete-position evidence gate.
- Cover settlement-window boundaries, net fees, complete empty windows, duplicates/conflicts, absent/partial history and wrong pool/subaccount. Runway must remain UNKNOWN when its prerequisites are invalid.
- Cover verified zero debt/positions separately from unavailable data, missing baseline, unsupported subaccount, ambiguous contract mapping, stale independent quotes and unverified notification/heartbeat metadata.
- Verify browsing, polling and account changes do not write monitor state, advance notification debounce, send messages or invoke execution/simulation submissions.
- Use the repository's offline typechecks, server/web tests and production web build. If monitor logic/contracts are changed, also run the separate Python monitor suite, which is not established as covered by the default CI job.
- For visible UI, perform browser visual/accessibility QA with safe fixture data when a preview is available. Offline tests or a successful build do not establish current live-account correctness or notification delivery.

## Out of Scope

- A new full Python collector, page-triggered monitor subprocesses, a second risk account configuration, independent polling scheduler or globally forced-fresh data policy.
- Automatic trades, transfers, collateral replenishment, liquidation protection, approvals, notification deployment or changes to standalone monitor operation.
- Re-enabling disabled checks, redesigning risk thresholds, inventing a verified baseline, or converting manual reviews into unsupported automatic safety judgments.
- A general risk platform for every asset/strategy, historical risk charts, a new evidence-entry editor or a redesign of existing terminal pages.
- Treating conditional liquidation/return models as official platform rules or treating an open terminal as an independent watchdog.
- Deploying external heartbeat receivers, configuring Telegram credentials or running live-order tests.

## Further Notes

- Confirmed product decisions: risk inspection and alert localization; terminal-consistent refresh; maximum reuse of current terminal data/calculation; the same terminal account context; all currently enabled checks; absent evidence shown as UNKNOWN with reasons.
- This specification supersedes the earlier page-triggered real-time collection proposal. Product decisions are settled; implementation must satisfy the source/coverage requirements above before claiming a metric is automatic.
- The repository already uses a local Markdown tracker. This specification is a ready-for-agent issue in that tracker and needs no additional triage. A formal tracker guide is not currently present; use `/setup-matt-pocock-skills` only if establishing persistent tracker tooling is desired.
- The user confirmed the test seam: the existing rendered-page/API-fixture boundary, with supplemental server tests where needed, including account switching, UNKNOWN and inactive-tab refresh behavior.
- No running-service, collection-latency or live-account acceptance is claimed by this document. It contains no account secrets, real balances or recorded live-account fixtures.
