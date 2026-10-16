# Risk monitor metric contracts

The catalog retains all checks, including temporarily disabled ones. The background service now reads the authenticated, read-only `GET /api/risk/report?address=<root>&fresh=1` endpoint. That endpoint composes existing terminal GET routes and uses the same `riskMeasurements`, `evaluateRisk`, and `visibleRiskChecks` functions as the Risk page. It emits the page's 25 visible checks, including PAUSED rollover checks. Category 8, historical market-identity and unexpected-position-change checks remain in the catalog but are omitted from both the page and background notifications. `scripts/risk-monitor-rules.json` defines thresholds and actions; `scripts/risk-monitor-metrics.json` defines value types, units, intended sources and maximum external evidence age. Threshold overrides remain management limits, not exchange liquidation rules.

`risk_monitor.py --watch --notify` retains its scheduling, process lock, scoped funding-gap history, collection heartbeat, Telegram queue, debounce and delivery receipts. Its normal monitoring loop no longer calls the legacy Python evaluator or independently fetches public Boros data. The old evaluator is retained only for historical offline fixtures; explicit `--accept-baseline` still uses the legacy collection path and remains opt-in. The service command and systemd unit do not change. Load the new terminal server before restarting the monitor, because an older server has no `/api/risk/report` route.

The service submits its previous scoped risk state so unresolved CRITICAL checks remain CRITICAL when their triggering evidence cannot be verified. With complete, verifiable evidence, the shared evaluator compares current values against the same effective thresholds regardless of prior status; history and the legacy `recoveryMarginFraction` do not shift those boundaries. A matching legacy producer identity permits migration of old critical state; another account or wallet does not inherit it. Failed, stale, malformed or scope-mismatched reports never trigger a legacy-formula fallback: current metrics become UNKNOWN and unresolved prior CRITICAL checks remain CRITICAL. PAUSED and hidden checks do not send notifications or retain queued alerts. Confirmed Telegram results are persisted separately and are used on the next report; sending a message does not rewrite the current report's snapshot or make expired delivery evidence fresh. `/api/risk/report` itself does not modify monitor files or send notifications.

Risk always uses the terminal's default complete position history on both the page and the service. Positions display preferences (`since` and per-leg `legSince`) do not change Risk's entry rates, fees, opening times or maturity-profit denominator. Missing or blank Gate account identity is UNKNOWN and preserves the last verified producer identity, notification queue and debounce state; only a proven different account or pool clears them.

For evidence matching and historical CRITICAL retention, `http://localhost:<port>` and `http://127.0.0.1:<port>` identify the same local terminal. The port, account, wallet, subaccount and configuration fingerprint must still match. Persisted fingerprints keep their original URL spelling for compatibility. This comparison does not expand the existing Host/Origin guards or permit IPv6/remote access.

`notify.last_success_at` is the original time of a persisted Telegram delivery confirmed by a positive `message_id`, not a current channel probe. Its `observedAt` is the collector's latest observation of that history, alongside the queue and failure counter. The 3600-second TTL applies to this collection observation, not to how long the terminal has been quiet. Old confirmed history with fresh state, no queued messages and zero failures remains OK without sending extra messages. Never-confirmed delivery, a send time after the state observation, and missing/expired/future collector state remain UNKNOWN; actual send failures still trigger WARNING/CRITICAL. No current Telegram connectivity is implied by historical confirmation.

Each report exposes the effective configuration fingerprint and terminal evidence directories. The monitor checks its thresholds, recovery margin, account/pool identity, `state_dir` and `observations_file` against these before changing persistent state. An alternate `--config` file is allowed when its effective values match the terminal; incompatible values produce an explicit configuration error and exit status 1 before notification or state-file writes. Use the terminal's `dataDir/risk-monitor/config.json` and matching evidence directories. If configuration evidence itself is unavailable, the report remains UNKNOWN instead of assuming that settings match. Management thresholds apply on the first collector run, independently of heartbeat availability; runtime observations still require their original scope and freshness checks.

Missing, invalid, future-dated or expired evidence produces UNKNOWN unless another measured condition establishes WARNING/CRITICAL. A previously measured CRITICAL remains CRITICAL while its triggering metric cannot be verified. `coverageComplete` describes metric availability only; it does not guarantee safety. Rollover checks other than days remaining are paused at 14 days or more only when the asset view explicitly reports `coverage.borosPositionsComplete=true` and every relevant maturity is valid. That flag covers positions for the configured Boros subaccount (`BOROS_ACCOUNT_ID`, 0–255; default 0), complete account reads, valid sizes and inclusion in the view with market metadata; history coverage flags do not substitute for it. Missing coverage, partial positions or a report scoped to another account or subaccount cannot clear queued alerts or unverifiable CRITICAL states.

External evidence needs `value`, `observed_at` in Unix seconds, positive `ttl_seconds`, a named `source` and an `evidence` reference. Numeric values must be finite JSON numbers, not strings or booleans. USD quotes must be positive; counts must be nonnegative integers. Enum values must belong to the lists below. An omitted unit uses the contract unit; an explicit wrong unit is rejected. File evidence expires at the shorter of its TTL and the contract maximum; CLI recording rejects a TTL above that maximum. Fresh live measurements take precedence. Notification state, service state and the local last-complete timestamp cannot be supplied manually.

External event reviews represent only the evidence reviewed at that time. A clear official announcement review does not establish custody, protocol or oracle safety. Stablecoin prices require independent USD quotes, never the terminal's fixed USD conversion. Selected Boros cross-group collateral is not total ETH exposure. Total exposure stays UNKNOWN until fresh evidence includes other assets and hedges. Pair-context absence cannot establish that a market is safe or available.

Source freshness for automatic values follows the actual endpoint fields and coverage gates. A response timestamp does not establish market-data freshness. The age limits below apply to external evidence, including fallback evidence for missing automatic values. Settlement flow uses signed net events in (now - 24 hours, now] for the configured root and Boros subaccount (`BOROS_ACCOUNT_ID`, 0–255; default 0). ETH and BTC native totals sum their respective currency across every matching cross and isolated collateral pool; the USD total converts each pool separately (USDT/USDC at 1:1 and other tokens using a current verified quote). Evidence details retain each pool and native currency separately. All pages for every pool must be read successfully; malformed events, conflicting duplicate IDs, pagination cycles and page caps leave the affected aggregate UNKNOWN. A complete empty window is zero. The flow includes closed-market settlements, already includes settlement fees, and does not require USD prices for native-currency totals. Buffer runway uses each net-outflow pool's available collateral divided by that pool's past-day net outflow, then reports the shortest verified runway; an inflow in another pool does not offset an outflow. A complete window with no outflows is NA. Local collection completion means mandatory requests succeeded; it does not mean all risk metrics are known.

| Metric | Unit | Type / accepted values | Collection | Maximum external age (seconds) | Intended source |
|---|---|---|---|---:|---|
| `agent.approval` | enum | approved, not-approved, expired, revoked, missing | automatic | 3600 | /boros/agent live approval/expiry |
| `agent.expiry_days` | days | number | derived | 3600 | /boros/agent live approval/expiry |
| `agent.gas_balance_usd` | USD | number | automatic | 3600 | 原始官方gas-balance或已有只读通道 |
| `basis.depth_coverage_ratio` | ratio | number | external | 120 | 双腿盘口按实际数量吃单估算 |
| `basis.executable_exit_cost_usd` | USD | number | external | 120 | 双腿盘口按实际数量吃单估算 |
| `basis.exit_cost_profit_ratio` | ratio | number | external | 120 | 双腿盘口按实际数量吃单估算 |
| `basis.loss_profit_ratio` | ratio | number | derived | 120 | /positions两腿mark/entry/qty |
| `basis.mark_spread_usd_per_eth` | USD/ETH | number | automatic | 120 | /positions两腿mark/entry/qty |
| `basis.pnl_usd` | USD | number | automatic | 120 | /positions两腿mark/entry/qty |
| `boros.adverse_spread_pp` | percentage points | number | derived | 3600 | asset-view markApr/entryApr/size/maturity |
| `boros.available_eth` | ETH | number | automatic | 3600 | Boros official selected cross group availableInitialMargin |
| `boros.buffer_runway_days` | days | number | derived | 3600 | Per-pool signed 24h settlement net and available collateral for the configured root/subaccount; shortest verified outflow runway |
| `boros.equity_positive` | bool | bool | derived | 3600 | Verified ETH/BTC account and independent collateral pools |
| `boros.equity_usd` | USD | number | derived | 3600 | Verified ETH/BTC account and independent collateral pools |
| `boros.im_coverage` | ratio | number | derived | 3600 | Boros official selected cross group netBalance / initialMargin |
| `boros.mm_health_ratio` | ratio | number | derived | 3600 | Boros official netBalance / (netBalance - availableMaintMargin) |
| `boros.mtm_loss_equity_ratio` | ratio | number | derived | 3600 | Sum of active Boros position unrealisedPnl valued at each collateral token USD quote, divided by total configured root/subaccount collateral equity |
| `boros.pool_available_nonnegative` | bool | bool | derived | 3600 | Verified ETH/BTC account and independent collateral pools |
| `boros.rate_mtm_usd` | USD | number | automatic | 3600 | Sum of active Boros position unrealisedPnl valued at each collateral token USD quote for the configured root/subaccount |
| `boros.settlement_net_24h_btc` | BTC/24h | number | derived | 3600 | Verified ETH/BTC account and independent collateral pools |
| `boros.settlement_net_24h_eth` | ETH/24h | number | automatic | 3600 | Signed ETH settlement totals by collateral pool for the configured root/subaccount, from complete 24h pages |
| `boros.settlement_net_24h_usd` | USD/24h | number | derived | 3600 | Per-pool signed settlement totals converted by currency; USDT/USDC at 1:1, other tokens at verified USD quotes |
| `collateral.eth_delta_usd` | USD | number | derived | 3600 | Verified total ETH exposure including other assets and hedges; current-price stress scenario |
| `collateral.eth_net` | ETH | number | external | 3600 | Verified total ETH exposure including other assets and hedges; current-price stress scenario |
| `collateral.stress_loss_profit_ratio` | ratio | number | derived | 3600 | Verified total ETH exposure including other assets and hedges; current-price stress scenario |
| `collateral.stress_loss_usd` | USD | number | derived | 3600 | Verified total ETH exposure including other assets and hedges; current-price stress scenario |
| `custody.incident_status` | enum | clear, active | external | 86400 | 官方公告+带证据的人工核查；不自动提现测试 |
| `custody.review_age_h` | hours | number | automatic | 86400 | 官方公告+带证据的人工核查；不自动提现测试 |
| `custody.withdrawal_status` | enum | available, restricted, unavailable | external | 86400 | 官方公告+带证据的人工核查；不自动提现测试 |
| `data.age_seconds` | seconds | number | automatic | 3600 | positions.updateTime and upstream stale fields; response meta.ts is not market time |
| `data.coverage_complete` | bool | bool | automatic | 3600 | positions.updateTime and upstream stale fields; response meta.ts is not market time |
| `data.stale` | bool | bool | automatic | 3600 | positions.updateTime and upstream stale fields; response meta.ts is not market time |
| `execution.halted_count` | count | number | automatic | 3600 | /deals、/alerts、/orders/open |
| `execution.pending_age_s` | seconds | number | automatic | 3600 | /deals、/alerts、/orders/open |
| `execution.unhedged_eth` | ETH | number | automatic | 3600 | /deals、/alerts、/orders/open |
| `gate.im_coverage` | ratio | number | derived | 3600 | /account |
| `gate.equity_positive` | bool | bool | derived | 120 | Verified ETH/BTC account and independent collateral pools |
| `gate.equity_usd` | USD | number | derived | 120 | Verified ETH/BTC account and independent collateral pools |
| `gate.interest_daily_usd` | USD/day | number | derived | 3600 | /account liabilities matched to /account/interest buckets.interestPerDayUsd; current daily estimate, USDT/USDC valued at $1 |
| `gate.liability_usdc` | USDC | number | automatic | 3600 | /account liabilities; external official daily interest evidence |
| `gate.liability_usdt` | USDT | number | automatic | 3600 | /account liabilities; external official daily interest evidence |
| `gate.liquidation_distance_pct` | ratio | number | derived | 3600 | /account/liquidation: nearest absolute move in terminal model; one coin moves, others fixed |
| `gate.loss_equity_ratio` | ratio | number | derived | 120 | Verified ETH/BTC account and independent collateral pools |
| `gate.mm_health_ratio` | ratio | number | derived | 3600 | /account |
| `gate.upnl_usd` | USD | number | derived | 120 | Verified ETH/BTC account and independent collateral pools |
| `hedge.binance_size_gap_eth` | ETH | number | derived | 3600 | asset-view与交易所实际持仓；逐venue核对方向 |
| `hedge.direction_match` | bool | bool | derived | 3600 | asset-view与交易所实际持仓；逐venue核对方向 |
| `hedge.hl_size_gap_eth` | ETH | number | derived | 3600 | asset-view与交易所实际持仓；逐venue核对方向 |
| `hedge.market_identity_match` | bool | bool | derived | 3600 | Boros市场描述/持仓maturity |
| `hedge.maturity_match` | bool | bool | derived | 3600 | Boros市场描述/持仓maturity |
| `hedge.perp_net_btc` | BTC | number | derived | 120 | Verified ETH/BTC account and independent collateral pools |
| `hedge.perp_net_eth` | ETH | number | derived | 3600 | Verified ETH/BTC account and independent collateral pools |
| `hedge.funding_gap_ratio` | ratio | number | derived | 120 | Largest per-source absolute gap / perpetual quantity |
| `hedge.funding_gap_usd` | USD | number | derived | 120 | Largest per-source gap principal at a verified USD mark |
| `hedge.funding_material_gap_ratio` | ratio | number | derived | 120 | Largest ratio above both $10 and one verified executable lot |
| `hedge.funding_unmatched` | bool | bool | derived | 120 | A source-side has only perpetual or only live Boros coverage |
| `hedge.quantity_verified` | bool | bool | derived | 120 | Verified ETH/BTC account and independent collateral pools |
| `hedge.residual_equity_ratio` | ratio | number | derived | 120 | Verified ETH/BTC account and independent collateral pools |
| `hedge.residual_usd` | USD | number | derived | 120 | Verified ETH/BTC account and independent collateral pools |
| `market.last_status_verified_at` | unix seconds | number | external | 3600 | 完整官方市场状态；不能仅用pair context筛选结果 |
| `market.trading_status` | enum | normal, restricted, halted, expired | external | 3600 | 完整官方市场状态；不能仅用pair context筛选结果 |
| `monitor.heartbeat_age_s` | seconds | number | external | 660 | 进程外监视读取心跳，不由自身保证 |
| `monitor.last_complete_run_at` | unix seconds | number | local | 660 | 进程外监视读取心跳，不由自身保证 |
| `notify.failure_streak` | count | number | local | 3600 | Telegram确认返回+本机持久化队列 |
| `notify.last_success_at` | unix seconds | number | local | 3600 | Telegram确认返回+本机持久化队列 |
| `notify.pending_count` | count | number | local | 3600 | Telegram确认返回+本机持久化队列 |
| `oracle.settlement_lag_s` | seconds | number | external | 3600 | 官方事件核查+实际settlement epoch进度 |
| `positions.unexpected_change_eth` | ETH | number | automatic | 3600 | 已确认基线与当前四腿仓位；数据不完整UNKNOWN |
| `protocol.incident_status` | enum | clear, active | external | 86400 | 官方事件核查+实际settlement epoch进度 |
| `protocol.review_age_h` | hours | number | automatic | 86400 | 官方事件核查+实际settlement epoch进度 |
| `rollover.days_to_maturity` | days | number | automatic | 3600 | 实际Boros到期时间 |
| `rollover.depth_coverage_ratio` | ratio lower bound | number | derived | 3600 | 实际size模拟/盘口及两腿全部费用，不只mid |
| `rollover.incremental_margin_usd` | USD | number | external | 3600 | 模拟旧/新仓共存阶段的保证金 |
| `rollover.next_net_apr` | APR fraction | number | automatic | 3600 | 实际size模拟/盘口及两腿全部费用，不只mid |
| `rollover.post_roll_coverage` | ratio | number | external | 3600 | 模拟旧/新仓共存阶段的保证金 |
| `rollover.uncovered_funding_eth` | ETH | number | automatic | 3600 | 永续存在且对应Boros不存在/已到期 |
| `rollover.uncovered_funding_seconds` | seconds | number | automatic | 3600 | 永续存在且对应Boros不存在/已到期 |
| `service.consecutive_failures` | count | number | local | 3600 | /health及认证只读接口、/deals |
| `service.http_ok` | bool | bool | local | 3600 | /health及认证只读接口、/deals |
| `service.last_success_age_s` | seconds | number | local | 3600 | /health及认证只读接口、/deals |
| `stablecoin.source_age_s` | seconds | number | automatic | 120 | 独立USD报价，不能把USDT/USDC价恒设1 |
| `stablecoin.usdc_deviation` | ratio | number | derived | 120 | 独立USD报价，不能把USDT/USDC价恒设1 |
| `stablecoin.usdc_usd` | USD | number | external | 120 | 独立USD报价，不能把USDT/USDC价恒设1 |
| `stablecoin.usdt_deviation` | ratio | number | derived | 120 | 独立USD报价，不能把USDT/USDC价恒设1 |
| `stablecoin.usdt_usd` | USD | number | external | 120 | 独立USD报价，不能把USDT/USDC价恒设1 |

## Account funding quantity tolerance

The current account rule matches live funding coverage independently by base asset (ETH/BTC), source venue and side. A spread is expanded in its verified source order: the first source keeps the Boros side and the second source takes the opposite side. PnL, collateral and maturity still count the original market once.

Signed gap = perpetual quantity minus live Boros coverage. Positive is uncovered; negative is overcoverage. The raw ratio is `abs(gap) / perpetual quantity` per source-side, and is 100% when Boros is present without a perpetual. `hedge.funding_gap_ratio` and `hedge.funding_gap_usd` show the largest individual ratio and dollar principal; they need not come from the same source. Details retain every signed quantity and source, without cross-source or cross-coin netting.

The default management limits are strictly greater than 0.1% for WARNING and 1% for CRITICAL. A ratio enters `hedge.funding_material_gap_ratio` only when its own gap exceeds $10 AND exceeds one verified executable lot (sum of lots if multiple contracts share a source-side). A missing/invalid/stale/future lot grants no lot exemption. `/positions.quantitySteps` preserves the rule-cache observation time; rules expire after 600 seconds. Lot evidence must be unique, live, and divide the actual quantity. A fully missing side or a wrong direction is independently CRITICAL even below $10 or one lot. Fresh complete empty positions have zero mismatch.

USD valuation uses the existing highest verified perpetual mark for the base; a Boros-only source may use its fresh collateral-token quote. Stablecoin quotes retain the existing 1:1 USD assumption. No verified USD mark means UNKNOWN for materiality/quantity acceptance; raw quantity ratios remain visible. Values exactly on the ratio, $10 or one-lot boundary do not trigger that boundary. Money/quantity differences and materiality comparisons use fixed-point integers before producing numeric metrics.

`hedge.quantity_verified` uses the same effective conditions as the funding check, including scoped ratio overrides. Old ETH absolute-threshold overrides are not reinterpreted as percentages: account mode falls back to the new defaults; the legacy offline ETH-cross evaluator retains its historical catalog. Absolute ETH metrics remain visible for diagnostics and verification of previous critical state. Missing triggering evidence continues to preserve prior CRITICAL; no state reset is needed. The Risk page, shared GET report and background monitor use the same account rule.

These are management defaults, not venue liquidation thresholds or calibrated loss guarantees. The $10 floor denotes funding principal, not a current loss, fee quote or stress-loss estimate. No orders, transfers, execution sizing or notification scheduling are changed.

## External heartbeat deployment and acceptance

Run the receiver on a different host with independent connectivity and its own confirmed Telegram credentials. Copy the `scripts/` directory and configuration examples there. Mirror the producer's `data/risk-monitor/heartbeat.json` with an atomic file replacement. Preserve its timestamps; never replace them with transfer time. Do not mirror API tokens, wallet data, local monitor state or the producer's Telegram file. Provision the transfer using your existing SSH access; no credentials belong in commands saved to Git.

Receiver configuration must set the producer interval (initially 300 seconds), a receiver-local `state_dir` and receiver-local `telegram_env`. Run checks every 60 seconds. A fresh incomplete collection is WARNING; missing, malformed, future-dated or older-than-660-second heartbeat is CRITICAL. A collector that stays alive but has no recent successful collection is also CRITICAL. A legacy heartbeat with `complete:true` uses its producer timestamp as the last completed timestamp. The receiver does not access the trading terminal.

Generate units on the receiver:

```bash
python3 scripts/risk_monitor_service.py --heartbeat /path/to/mirrored/heartbeat.json --config /path/to/external-monitor-config.json --output-dir /path/to/generated-units --check-seconds 60
```

Inspect the generated service and timer, then install them on that host:

```bash
systemctl --user link /path/to/generated-units/arbitrage-risk-heartbeat.service /path/to/generated-units/arbitrage-risk-heartbeat.timer
systemctl --user daemon-reload
systemctl --user enable --now arbitrage-risk-heartbeat.timer
systemctl --user status arbitrage-risk-heartbeat.timer
journalctl --user -u arbitrage-risk-heartbeat.service -n 80
```

The receiver service treats risk exit code 2 as a completed check. Delivery failure exits 1. The timer retries on its next activation. Both producer and receiver persist queued notifications before sending and checkpoint each confirmed batch. Restart retries only unconfirmed batches. Delivery is at least once: a crash between remote confirmation and the local checkpoint can duplicate a message. Both use local file locks to exclude concurrent writers.

Deployment acceptance requires observing receiver notifications for a deliberately stale copied heartbeat, restoring a fresh copy and observing recovery, and then interrupting only the heartbeat transfer to verify actual host/network separation. Use synthetic files for stale/future/malformed checks; never stop the trading service. Offline tests and generated units do not establish live external coverage. Telegram delivery requires separately confirming the recipient and test message through the local wizard. A receiver itself needs an independent watchdog if its own host failure must also be covered.
