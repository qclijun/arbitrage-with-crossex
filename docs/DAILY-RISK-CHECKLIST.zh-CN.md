# 日常风险检查与 Telegram 预警

本清单覆盖四腿资金费套利的八类风险，共33个检查项，其中ETH抵押品价格风险的2项及实际退出成本的1项暂不监控，当前启用30项。监控只读，默认每300秒运行一次，频率和全部阈值可配置。阈值是资金管理线，不是平台清算规则。

## 八类风险简要说明

2026-10-06：终端 Risk 页面暂时移除第 8 类的稳定币价格、托管事件与提现通道、协议/预言机事件三组检查及其指标，不计入页面风险状态汇总。下方风险说明、检查清单及指标契约保留，独立风险监控规则不变。

以下编号与检查清单的“风险”列对应。四腿对冲降低部分价格和资金费敞口，但各账户的保证金、现金流和执行状态仍需分别检查。

1. **Boros 保证金与结算消耗风险**：利率变化会改变仓位估值，持续资金费结算也可能消耗抵押品。即使到期收益预期为正，期间缓冲不足仍可能触及清算条件；初始保证金覆盖率不能替代维持保证金健康度。
2. **Gate 保证金与借款风险**：永续仓位的浮动亏损、保证金占用和钱包负权益可能压缩可用资金，并产生借款利息。另一侧账户盈利不代表 Gate 已获得所需资金，必须单独检查其保证金与负债。
3. **ETH 抵押品价格风险**：用 ETH 提供抵押品会保留其美元价格敞口；ETH 下跌可能减少抵押品的美元价值，侵蚀策略收益。计算总敞口时需包含其他资产和额外对冲，不能只看两条永续或单个 Boros 账户组。
4. **跨平台价差与退出成本风险**：两条永续数量相抵，也可能因平台标记价变化不同而产生价差损益。实际平仓还受买卖价差、盘口深度和滑点影响，标记价盈利不能代表可成交的退出收益。
5. **四腿匹配与执行风险**：数量、方向、市场或期限不匹配，以及部分成交、订单悬而未决、清算或 ADL，都可能留下未对冲敞口。总净数量接近零不代表每条资金费腿正确匹配，需逐腿核对实际持仓和成交。
6. **到期与展期风险**：Boros 仓位到期后，仍保留的永续可能失去对应的资金费对冲。展期还受下一期收益、市场交易限制、盘口和新旧仓重叠保证金约束，可能出现对冲空档或无法按计划退出。
7. **数据、运行与通知风险**：过期或不完整的数据、API 故障、授权失效、gas 不足及服务停机，会影响风险判断或后续操作。监控存活不代表采集成功，通知已排队也不代表送达；整机失联需由外部主机检测。
8. **稳定币、托管与协议风险**：稳定币脱锚、平台提现受限、托管损失、合约漏洞或预言机异常，都可能影响资产价值和资金可用性。近期公告正常或人工核查有效，只说明证据新鲜，不能保证平台或协议安全。

## 每日检查清单

到期提醒只监控剩余天数，不监控计划确认时间；进入临近到期预警后，再制定展期或退出方案。

临近到期的时间安排、展期准入、分批切换、到期交接及失败处理见[展期执行计划](ROLLOVER-PLAN.zh-CN.md)。

暂不统计ADL事件次数；非预期仓位变化检查只使用`positions.unexpected_change_eth`，不因缺少ADL事件证据而报UNKNOWN。偏离基线时仍需核对原因；数值为0不替代数量、方向和到期检查。

风险3的“ETH抵押品价格暴露”和“美元压力损失”暂不监控，相关四个指标不输出、不触发告警。规则中的`enabled:false`保留其定义，恢复时改为`true`并提供完整敞口证据；暂停不代表该风险消失。

风险4的“实际退出成本”也暂不监控，相关三个指标不输出、不触发告警；“永续标记价差”及其三个指标继续监控。恢复退出成本检查时需启用规则并提供有效盘口与成本证据。

### 终端 Risk 的当前对冲与历史基线（2026-10-06）

终端的“永续数量中性”直接汇总账户匹配、完整且新鲜的实际 ETH 永续数量（多头为正、空头为负），不依赖 Boros 读取、钱包选择或历史基线。完整空仓为 0；缺失、重复、合约不明确或未能核实的读取仍为 UNKNOWN。

“每条资金费腿匹配”复用当前 ETH cross-pool 的 Boros 持仓与永续持仓，要求同一钱包/子账户、两个不同市场、唯一 Hyperliquid/Binance 两腿及有效到期日。逐 venue 比较 ETH 数量绝对差，并核对 Hyperliquid SHORT、Binance LONG 和对应永续方向；不依赖历史基线。额外市场、重复合约、缺腿、过期或不完整读数为 UNKNOWN，已确认方向错误为 CRITICAL。

“期限匹配”只比较两条当前 Boros 腿的到期时间。“策略市场身份（历史基线）”独立核对历史预期市场 ID 和永续合约；“非预期仓位变化”独立核对历史数量。后两项仍要求明确的账户范围、观察时间和证据，缺少有效基线为 UNKNOWN。不得把当前仓位自动写成历史基线来消除 UNKNOWN；到期一致也不证明历史市场身份正确。以上当前持仓计算适用于终端页面，独立 Python 采集器的计算与基线机制保持原有行为；两者共用拆分后的检查目录和阈值。

### 永续标记价差：定义与计算决策（2026-10-06）

以下公式按 Hyperliquid 永续做空、Binance 永续做多说明；`H` 表示 Hyperliquid，`B` 表示 Binance，`M` 为当前标记价，`E` 为开仓均价，`q` 为正数 ETH 数量。

- `basis.mark_spread_usd_per_eth = M_H - M_B`，单位 USD/ETH。正值表示 Hyperliquid 标记价更高；当前价差本身不能判断持仓盈亏，需比较开仓价差。它不是可成交的买卖价差。
- `basis.pnl_usd = upnl_H + upnl_B`，单位 USD；读取两条永续的上游未实现价格盈亏。线性合约可理解为 `q_H × (E_H - M_H) + q_B × (M_B - E_B)`；等量时为 `q × [(E_H - E_B) - (M_H - M_B)]`。不含资金费、手续费、Boros 结算/利率估值或 ETH 抵押品汇率损益；数量不等时还包含残余方向敞口。
- `basis.loss_profit_ratio = max(0, -basis.pnl_usd) / F`，其中 `F` 使用终端四腿配对表 **Profit at maturity** 的计算方法及默认费用选项。它是条件收益估算，有限且大于零才可作分母。两腿合计盈利时分子为零，不能拿亏损单腿作为分子。

`Profit at maturity` 为配对的年化固定收益乘以对冲期限，再扣除配对计入的费用。年化固定收益已扣 Boros 结算费率；期限从四腿首次完成对冲的估计时间到共同到期日，不知道起始时间时使用当前时间估算剩余期限。费用默认计入 Boros 交易费，永续开仓费沿用配对默认规则（永续早于 Boros 超过三天时不计入），不计预计永续退出费。Risk 使用默认费用、无可选返佣覆盖；Positions 的临时费用开关或返佣覆盖不改变 Risk 口径。它不是已实现利润，也不是扣除借款利息、滑点等全部成本的保证收益。

终端 Risk 的此项分母不依赖独立 `baseline`、基线时间或历史覆盖起点；沿用现有资产读数中的配对模型。必要条件是账户/钱包/子账户匹配、有效观察时间与新鲜度、完整当前持仓及费用历史读数、正确四腿方向和同一有效到期日、必要数值有限、唯一可识别配对且 `F > 0`。失败时显示具体 UNKNOWN 原因，不能用旧 collector 的 ratio 覆盖本地失败。

数量容差固定为 **0.001 ETH（绝对差，含边界）**，同时检查两条永续、两条 Boros 以及每个平台的永续/Boros 数量差；超过容差为 UNKNOWN。容差内由现有配对模型按可配数量估算收益，实际数量不改写，其他数量缺口与基线变化检查继续独立执行。此容差用于收益估算准入，不代表残余敞口为零或清算安全。

合成示例：开仓价差 `2002 - 2000 = 2 USD/ETH`，当前价差 `2001 - 2000 = 1 USD/ETH`；等量 `2 ETH` 的合计价格盈亏为 `+2 USD`。若 `Profit at maturity = 60 USD`，ratio 为 `0`；合计价格亏损 `18 USD` 时 ratio 为 `0.30`，触发 WARNING。默认阈值严格大于 `0.25` 为 WARNING、严格大于 `0.50` 为 CRITICAL，它们是管理阈值而非交易所清算规则。

以上分母决策适用于终端 Risk 页面；独立 Python collector 当前仍使用其旧基线收益模型，不应将两者当作同一口径。

| 风险 | 检查项 / 指标ID | 默认预警规则 | 应对措施 |
|---|---|---|---|
| 1 | 1. Boros 总体缓冲：`boros.im_coverage` | boros.im_coverage lt 1.3 → WARNING；boros.im_coverage lt 1.15 → CRITICAL | 准备/补充ETH或协调减仓，勿从另一侧抽走必要保证金 |
| 1 | 1. Boros 清算健康度：`boros.mm_health_ratio` | boros.mm_health_ratio lt 1.5 → WARNING；boros.mm_health_ratio lt 1.2 → CRITICAL | 在触及清算区域前补抵押品或协调减仓 |
| 1 | 1. Boros 可用余额：`boros.available_eth` | boros.available_eth lt 0.005 → WARNING；boros.available_eth lt 0 → CRITICAL；boros.available_eth eq 0 → CRITICAL | 核对占用、挂单与结算，补充缓冲 |
| 1 | 1. 利率估值损失：`boros.adverse_spread_pp`、`boros.rate_mtm_usd`、`boros.mtm_loss_equity_ratio` | boros.adverse_spread_pp gt 1 → WARNING；boros.adverse_spread_pp gt 2 → CRITICAL；boros.mtm_loss_equity_ratio gt 0.1 → WARNING；boros.mtm_loss_equity_ratio gt 0.2 → CRITICAL | 检查HL上涨/Binance下跌的利差变化和实际健康度 |
| 1 | 1. 持续结算消耗：`boros.settlement_net_24h_eth`、`boros.buffer_runway_days` | boros.buffer_runway_days lt 7 → WARNING；boros.buffer_runway_days lt 2 → CRITICAL | 预备抵押品；检查资金是否迁移到Gate |
| 2 | 2. Gate 初始保证金缓冲：`gate.im_coverage` | gate.im_coverage lt 1.2 → WARNING；gate.im_coverage lt 1.1 → CRITICAL | 限制新暴露，补资金或协调缩仓 |
| 2 | 2. Gate 清算健康度：`gate.mm_health_ratio` | gate.mm_health_ratio lt 2 → WARNING；gate.mm_health_ratio lt 1.5 → CRITICAL | 优先保证账户持续偿付能力 |
| 2 | 2. 钱包借款：`gate.liability_usdt`、`gate.liability_usdc`、`gate.interest_daily_usd` | gate.liability_usdt gt 0 → WARNING；gate.liability_usdc gt 0 → WARNING | 核对负权益和计息规则，检查Rebalance或补资金 |
| 2 | 2. 清算距离：`gate.liquidation_distance_pct` | gate.liquidation_distance_pct lt 0.3 → WARNING；gate.liquidation_distance_pct lt 0.15 → CRITICAL | 结合MM、借款与价差决定补缓冲或缩仓 |
| 3 | 3. ETH抵押品价格暴露：`collateral.eth_net`、`collateral.eth_delta_usd`、`collateral.stress_loss_profit_ratio` | collateral.stress_loss_profit_ratio gt 1 → WARNING | 单独记录抵押品汇率损益，明确是否接受该敞口 |
| 3 | 3. 美元压力损失：`collateral.stress_loss_usd`、`collateral.stress_loss_profit_ratio` | collateral.stress_loss_profit_ratio gt 1 → WARNING | 调整敞口/资金配置，重算收益与风险 |
| 4 | 4. 永续标记价差：`basis.mark_spread_usd_per_eth`、`basis.pnl_usd`、`basis.loss_profit_ratio` | basis.loss_profit_ratio gt 0.25 → WARNING；basis.loss_profit_ratio gt 0.5 → CRITICAL | 查持续性与盘口，结合保证金决定协调缩仓 |
| 4 | 4. 实际退出成本：`basis.executable_exit_cost_usd`、`basis.depth_coverage_ratio`、`basis.exit_cost_profit_ratio` | basis.exit_cost_profit_ratio gt 0.25 → WARNING；basis.depth_coverage_ratio lt 1 → WARNING | 不用标记价替代成交价；控制双腿执行间隔 |
| 5 | 5. 永续数量中性：`hedge.perp_net_eth` | hedge.perp_net_eth abs_gt 0.001 → WARNING；hedge.perp_net_eth abs_gt 0.01 → CRITICAL | 核对订单与成交后处理残量，禁止盲目重复下单 |
| 5 | 5. 每条资金费腿匹配：`hedge.hl_size_gap_eth`、`hedge.binance_size_gap_eth`、`hedge.direction_match` | hedge.hl_size_gap_eth gt 0.001 → WARNING；hedge.binance_size_gap_eth gt 0.001 → WARNING；hedge.hl_size_gap_eth gt 0.01 → CRITICAL；hedge.binance_size_gap_eth gt 0.01 → CRITICAL；hedge.direction_match eq False → CRITICAL | 协调修复对应腿，避免只看总净delta |
| 5 | 5. 期限匹配：`hedge.maturity_match` | hedge.maturity_match eq False → CRITICAL | 暂停扩大规模，核对原始成交 |
| 5 | 5. 策略市场身份（历史基线）：`hedge.market_identity_match` | hedge.market_identity_match eq False → CRITICAL | 核对可信历史成交与策略基线；不得自动接纳当前仓位 |
| 5 | 5. 执行残留：`execution.unhedged_eth`、`execution.halted_count`、`execution.pending_age_s` | execution.unhedged_eth abs_gt 0.001 → CRITICAL；execution.halted_count gt 0 → CRITICAL；execution.pending_age_s gt 120 → WARNING | 查真实订单状态，不把超时当作未成交 |
| 5 | 5. 非预期仓位变化：`positions.unexpected_change_eth` | positions.unexpected_change_eth gt 0.001 → CRITICAL | 核对是否清算/ADL，重建四腿对冲 |
| 6 | 6. 到期提醒：`rollover.days_to_maturity` | rollover.days_to_maturity lt 14 → WARNING；rollover.days_to_maturity lt 1 → CRITICAL | 临近到期时制定展期或退出方案 |
| 6 | 6. 下一期机会：`rollover.next_net_apr`、`rollover.depth_coverage_ratio` | rollover.next_net_apr lt 0 → WARNING；rollover.depth_coverage_ratio lt 1 → WARNING | 不为省手续费强行展期 |
| 6 | 6. 重叠保证金：`rollover.incremental_margin_usd`、`rollover.post_roll_coverage` | rollover.post_roll_coverage lt 1.3 → WARNING | 预留展期抵押品；逐笔确认新旧仓 |
| 6 | 6. 资金费对冲空档：`rollover.uncovered_funding_seconds`、`rollover.uncovered_funding_eth` | rollover.uncovered_funding_eth gt 0.001 → WARNING；rollover.uncovered_funding_seconds gt 300 → CRITICAL | 建立正确下一期对冲或执行既定退出方案 |
| 6 | 6. 市场交易限制：`market.trading_status`、`market.last_status_verified_at` | market.trading_status ne normal → WARNING；market.trading_status eq halted → CRITICAL | 准备受限市场的退出/展期替代方案 |
| 7 | 7. 数据新鲜度：`data.age_seconds`、`data.stale`、`data.coverage_complete` | data.age_seconds gt 120 → WARNING；data.age_seconds gt 600 → CRITICAL；data.stale eq True → WARNING；data.coverage_complete eq False → WARNING | 不依据过期信息继续扩大仓位 |
| 7 | 7. API与执行服务：`service.http_ok`、`service.consecutive_failures`、`service.last_success_age_s` | service.http_ok eq False → WARNING；service.consecutive_failures gt 1 → WARNING；service.last_success_age_s gt 600 → CRITICAL | 查网络/进程/订单，保持恢复证据 |
| 7 | 7. Boros授权：`agent.approval`、`agent.expiry_days` | agent.approval ne approved → CRITICAL；agent.expiry_days lt 30 → WARNING；agent.expiry_days lt 7 → CRITICAL | 提前更新授权并验证，勿等待退出时才处理 |
| 7 | 7. Gas余额：`agent.gas_balance_usd` | agent.gas_balance_usd lt 2 → WARNING；agent.gas_balance_usd lt 0.2 → CRITICAL | 在本机确认交易gas预算与充值方式 |
| 7 | 7. 监控自身存活：`monitor.heartbeat_age_s`、`monitor.last_complete_run_at` | monitor.heartbeat_age_s gt 660 → CRITICAL | 查监控服务与主机，不把未运行当作正常 |
| 7 | 7. Telegram送达：`notify.last_success_at`、`notify.pending_count`、`notify.failure_streak` | notify.failure_streak gt 0 → WARNING；notify.failure_streak gt 2 → CRITICAL | 重试并保留日志，恢复后补发；隐藏token/chat id |
| 8 | 8. 稳定币价格：`stablecoin.usdt_usd`、`stablecoin.usdc_usd`、`stablecoin.source_age_s`、`stablecoin.usdt_deviation`、`stablecoin.usdc_deviation` | stablecoin.usdt_deviation gt 0.005 → WARNING；stablecoin.usdc_deviation gt 0.005 → WARNING；stablecoin.usdt_deviation gt 0.01 → CRITICAL；stablecoin.usdc_deviation gt 0.01 → CRITICAL | 评估实际权益和退出/转账通道 |
| 8 | 8. 托管事件与提现通道：`custody.incident_status`、`custody.review_age_h`、`custody.withdrawal_status` | custody.incident_status ne clear → CRITICAL；custody.withdrawal_status ne available → WARNING；custody.review_age_h gt 24 → WARNING | 不扩大托管规模，确认可执行的资金访问路径 |
| 8 | 8. 协议/预言机事件：`protocol.incident_status`、`protocol.review_age_h`、`oracle.settlement_lag_s` | protocol.incident_status ne clear → CRITICAL；protocol.review_age_h gt 24 → WARNING；oracle.settlement_lag_s gt 7200 → WARNING | 对照实际结算与公告，保持备用资金 |

比较符号：`lt`小于、`gt`大于、`abs_gt`绝对值大于、`eq`相等、`ne`不相等。比率使用倍数或小数（0.30=30%），APR使用小数，APR利差变化使用百分点。每个指标输出值、单位、来源、采集/观察时间、数据年龄和覆盖状态。68个指标的类型、允许值、外部证据有效期及部署验收见 [指标契约](RISK-MONITOR-CONTRACTS.md)。68个指标的类型、允许值、外部证据有效期及部署验收见 [指标契约](RISK-MONITOR-CONTRACTS.md)。

`gate.interest_daily_usd` 自动汇总终端 `/account/interest` 各钱包的当前每日利息估算，并与 `/account` 的负债核对：计息借款额 × 当前小时利率 × 24。HL USDC 钱包扣除 10,000 USDC 免息额度，其他钱包不套用该额度。金额沿用终端 USDT/USDC 按 $1 估值的口径，不代表过去24小时实际扣息，也不代替独立稳定币报价。接口失败、借款不一致、计息钱包利率缺失或数据无效时，自动值为 UNKNOWN；仍可按指标契约提供有效外部证据作为后备。

`gate.liquidation_distance_pct` 自动读取 `/account/liquidation`，复用终端清算价模型，取各币种上涨/下跌清算点中最近的绝对价格变动比例（0.30=30%）。模型每次只让一个币种在各交易所按同比例变价，其他币种保持不动；模拟浮盈亏、仓位维持保证金及新增钱包借款，求保证金余额等于维持保证金的价格。缺少档位表时沿用当前仓位保证金率，不预测未来资金费、利息或交易所价差。接口失败、持仓数据不完整、存在未定价仓位或未找到有限清算点时自动值为 UNKNOWN；不是官方清算价或安全保证，仍允许有效外部证据作为后备。

## 配置与启动

需要Linux/Unix、Python 3.9+标准库、运行中的本机终端和网络。不安装Python第三方包，不修改交易引擎。

运行本机配置向导：

```bash
bash scripts/setup-risk-monitor.sh
```

向导使用你自己的专用Telegram bot，隐藏输入token，确认私聊接收方并发送测试；配置保存在Git忽略的`data/risk-monitor/telegram.env`，权限0600。不要把凭据发到聊天。向导可启用独立的systemd用户服务，也可前台运行。

```bash
python3 scripts/risk_monitor.py --json
python3 scripts/risk_monitor.py --watch --notify
python3 scripts/risk_monitor.py --watch --notify --interval-seconds 60
```

本机配置在`data/risk-monitor/config.json`。`interval_seconds`默认300，CLI参数优先。修改配置后重启风险监控进程即可，不重启交易服务。`--accept-baseline`明确接纳当前实际持仓作为基线；展期/人工调整后先核对持仓，再执行，不要自动跟随异常减仓更新基线。

```bash
python3 scripts/risk_monitor.py --accept-baseline
```

阈值可覆盖，键对应检查项ID，条件为[metric,op,value,severity]：

```json
{"interval_seconds":300,"thresholds":{"gate.im_coverage":[["gate.im_coverage","lt",1.30,"WARNING"],["gate.im_coverage","lt",1.15,"CRITICAL"]]}}
```

完整可复制配置见`scripts/risk-monitor-config.example.json`，默认规则见`scripts/risk-monitor-rules.json`。预计rolling收益仅用于压力比例：同到期、正确方向、完整历史等前提成立时估算，不是全年保证收益；下一期`netFixedApr`是按名义本金的APR。`notional_usd`是下一期扫描规模，需与实际目标规模一致。已roll入下一期时可设置`include_perp_entry_cost:false`，避免把上一期永续开仓费重复计入。

## 未知指标与人工核查

`UNKNOWN`表示缺少有效证据，不表示安全。脚本仍输出这些检查项并通知。结算净流出按最近24小时逐笔净事件汇总，首次运行无需等待本地采样；事件分页或校验不完整时为UNKNOWN，完整空窗口为0。缓冲可撑天数还需要同一抵押池的官方可用余额，不依赖美元报价或正IM。只有资产视图明确证明当前仓位完整且到期信息有效，才暂停14天窗口外的展期检查；缺少该证据时保留检查与未验证的CRITICAL。官方提款/托管/安全事件、可靠ADL原因、完整退出盘口深度、官方市场状态和外部心跳等需要独立数据或人工核查。USDT/USDC报价不能固定设为1。

外部数据/人工记录可写入`data/risk-monitor/observations.json`：每个metric需要真实value、observed_at（Unix秒）、ttl_seconds、source和evidence；缺失、类型或单位不符、未来时间、过期均不参与安全判断。数值必须是有限JSON数字；枚举必须属于指标契约。TTL不得超过契约上限；稳定币报价最多120秒。也可用命令记录，下面仅是格式示例，必须先实际核查：

```bash
python3 scripts/risk_monitor.py --record custody.incident_status --value '"clear"' --source "官方公告人工核查" --evidence "已核查公告的URL或本机记录" --ttl-seconds 86400
```

关联的提现状态需单独记录`custody.withdrawal_status`（available/restricted）；协议事件记录`protocol.incident_status`（clear/active）。这些只是有时效的证据，不能证明托管或协议没有风险。独立稳定币报价记录`stablecoin.usdt_usd`、`stablecoin.usdc_usd`；必须是可靠USD报价及真实时间。自动采集指标不会被人工记录覆盖。

## 通知及失联检测

默认一般WARNING/UNKNOWN连续2轮后通知；CRITICAL与方向/仓位变化等即时处理。只在状态变化、恢复或持续异常达6小时后提醒。数值解除阈值默认3%迟滞，避免来回报警。发送前持久化本机队列，每批确认后保存状态；发送失败保留队列并重试；只有Telegram确认成功才记录已发送，消息不包含token或钱包地址。分批发送采用至少一次交付，进程在发送确认后、保存状态前崩溃时可能重复。

状态、完整报告、心跳分别存放在`data/risk-monitor/state.json`、`latest.json`、`heartbeat.json`。`--json`适合机器读取，默认表格适合人工。单次检查遇到非OK返回退出码2；进程故障返回非零。持续模式保持循环，由独立用户服务负责自动重启。

本机脚本无法在整机断网/关机时自行发Telegram。把心跳文件同步到另一台机器，在那台机器使用独立Telegram配置执行：

```bash
python3 scripts/risk_monitor.py --config /path/to/external-monitor-config.json --heartbeat /path/to/mirrored/heartbeat.json --notify
```

外部心跳检查的正常路径只检查心跳，不访问交易终端；超过2个检查周期+60秒报警；缺失、损坏或未来时间均告警。新鲜但采集失败报WARNING，长期没有完整采集报CRITICAL。可生成独立主机的service/timer，部署步骤见指标契约。必须实际部署独立心跳监视后，该项才有覆盖，不能用自身心跳证明监控不会失联。

## 验证

```bash
python3 -m unittest discover -s tests/monitor -v
bash -n scripts/setup-risk-monitor.sh
```

不运行`tests/live/`，不下交易订单。Telegram协议依据[官方Bot API](https://core.telegram.org/bots/api)。
