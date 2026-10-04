# Risk monitor metric contracts

The 32 defined checks reference 68 distinct metrics. The two ETH collateral price-risk checks and the executable exit-cost check are temporarily disabled (`enabled: false`); the monitor emits 29 checks referencing 61 metrics. The perpetual mark-spread check remains enabled. Maturity alerts use only days remaining; plan-confirmation timestamps are not monitored. Plans are prepared when maturity approaches. ADL event counting is temporarily omitted; the unexpected-position-change check uses only the baseline quantity deviation. Disabled checks are omitted from reports and notifications, and their queued alerts and prior statuses are cleared on evaluation. `scripts/risk-monitor-rules.json` defines thresholds and actions; `scripts/risk-monitor-metrics.json` defines value types, units, intended sources and maximum external evidence age. Threshold overrides remain management limits, not exchange liquidation rules.

Missing, invalid, future-dated or expired evidence produces UNKNOWN unless another measured condition establishes WARNING/CRITICAL. A previously measured CRITICAL remains CRITICAL while its triggering metric cannot be verified. `coverageComplete` describes metric availability only; it does not guarantee safety.

External evidence needs `value`, `observed_at` in Unix seconds, positive `ttl_seconds`, a named `source` and an `evidence` reference. Numeric values must be finite JSON numbers, not strings or booleans. USD quotes must be positive; counts must be nonnegative integers. Enum values must belong to the lists below. An omitted unit uses the contract unit; an explicit wrong unit is rejected. File evidence expires at the shorter of its TTL and the contract maximum; CLI recording rejects a TTL above that maximum. Fresh live measurements take precedence. Notification state, service state and the local last-complete timestamp cannot be supplied manually.

External event reviews represent only the evidence reviewed at that time. A clear official announcement review does not establish custody, protocol or oracle safety. Stablecoin prices require independent USD quotes, never the terminal's fixed USD conversion. Selected Boros cross-group collateral is not total ETH exposure. Total exposure stays UNKNOWN until fresh evidence includes other assets and hedges. Pair-context absence cannot establish that a market is safe or available.

Source freshness for automatic values follows the actual endpoint fields and coverage gates. A response timestamp does not establish market-data freshness. The age limits below apply to external evidence, including fallback evidence for missing automatic values. Settlement samples written before completeness was recorded are excluded until a new complete 24-hour window exists. Local collection completion means mandatory requests succeeded; it does not mean all risk metrics are known.

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
| `boros.buffer_runway_days` | days | number | derived | 3600 | 两次以上采样与结算账本窗口 |
| `boros.im_coverage` | ratio | number | derived | 3600 | Boros official selected cross group netBalance / initialMargin |
| `boros.mm_health_ratio` | ratio | number | derived | 3600 | Boros official netBalance / (netBalance - availableMaintMargin) |
| `boros.mtm_loss_equity_ratio` | ratio | number | derived | 3600 | asset-view markApr/entryApr/size/maturity |
| `boros.rate_mtm_usd` | USD | number | automatic | 3600 | asset-view markApr/entryApr/size/maturity |
| `boros.settlement_net_24h_eth` | ETH/24h | number | automatic | 3600 | 两次以上采样与结算账本窗口 |
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
| `gate.interest_daily_usd` | USD/day | number | derived | 3600 | /account liabilities matched to /account/interest buckets.interestPerDayUsd; current daily estimate, USDT/USDC valued at $1 |
| `gate.liability_usdc` | USDC | number | automatic | 3600 | /account liabilities; external official daily interest evidence |
| `gate.liability_usdt` | USDT | number | automatic | 3600 | /account liabilities; external official daily interest evidence |
| `gate.liquidation_distance_pct` | ratio | number | derived | 3600 | /account/liquidation: nearest absolute move in terminal model; one coin moves, others fixed |
| `gate.mm_health_ratio` | ratio | number | derived | 3600 | /account |
| `hedge.binance_size_gap_eth` | ETH | number | derived | 3600 | asset-view与交易所实际持仓；逐venue核对方向 |
| `hedge.direction_match` | bool | bool | derived | 3600 | asset-view与交易所实际持仓；逐venue核对方向 |
| `hedge.hl_size_gap_eth` | ETH | number | derived | 3600 | asset-view与交易所实际持仓；逐venue核对方向 |
| `hedge.market_identity_match` | bool | bool | derived | 3600 | Boros市场描述/持仓maturity |
| `hedge.maturity_match` | bool | bool | derived | 3600 | Boros市场描述/持仓maturity |
| `hedge.perp_net_eth` | ETH | number | derived | 3600 | /positions实际signed qty |
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
