# 四腿资金费套利日常风险检查指标草案

状态：wayfinder 建图草案，监控脚本尚未实现；阈值尚待确认。

## 验收约束

覆盖此前讨论的八类风险。每行至少有 metric id、数据来源、单位/计算方法、预警条件和对应措施。指标缺失、数据过期或覆盖不完整不得记为 OK。监控只读，不触发交易动作。

## 术语

- **检查项**：有具体风险目的的日常核查动作。
- **监控指标**：含值、单位、来源、采集时间、有效期及覆盖状态的观察结果；可为实测、派生或人工确认。
- **初始保证金覆盖率**：净权益 / 初始保证金；只用于管理缓冲，不是清算判据。
- **维持保证金健康度**：净权益 / 维持保证金；不能与 Boros UI 的 0–1 Health Factor 混用。
- **UNKNOWN**：无法在约定有效期和覆盖范围内核实指标；必须说明缺失原因。
- **预警**：数值/事件越过管理线，或证据缺失/过期需要处理；不代表已发生清算。
- **人工核查有效期**：最近一次人工证据的时间及到期时间；只衡量核查新鲜度，不证明风险不存在。

## 候选阈值

以下管理线可配置且未经用户确认，不能当成平台规则。比率采用倍数，APR 使用小数，APR 差变化采用百分点；价格、金额分别明确币种。规则应设置解除阈值，避免阈值附近反复通知。

| 风险与检查项 | Metric id 与单位/计算 | 数据来源及覆盖方式 | 候选预警条件 | 应对措施 |
|---|---|---|---|---|
| 1. Boros 总体缓冲 | `boros.im_coverage`，netBalance / IM | 原始抵押品账户；终端可用额度加对应 IM 派生 | <1.30 警告；<1.15 紧急；参考目标1.50 | 准备/补充ETH或协调减仓，勿从另一侧抽走必要保证金 |
| 1. Boros 清算健康度 | `boros.mm_health_ratio`，netBalance / MM | 必须读取官方MM；不从IM冒充派生 | <1.50 警告；<1.20 紧急；缺MM为UNKNOWN | 在触及清算区域前补抵押品或协调减仓 |
| 1. Boros 可用余额 | `boros.available_eth`，ETH | pair context crossByToken.available | ≤0紧急；持续下降趋势警告 | 核对占用、挂单与结算，补充缓冲 |
| 1. 利率估值损失 | `boros.adverse_spread_pp`、`boros.rate_mtm_usd` | asset-view markApr/entryApr/size/maturity | 负MTM超过Boros权益10%警告、20%紧急 | 检查HL上涨/Binance下跌的利差变化和实际健康度 |
| 1. 持续结算消耗 | `boros.settlement_net_24h_eth`、`boros.buffer_runway_days` | 两次以上采样与结算账本窗口 | 外流时缓冲可撑<7天警告、<2天紧急；采样不足UNKNOWN | 预备抵押品；检查资金是否迁移到Gate |
| 2. Gate 初始保证金缓冲 | `gate.im_coverage`，净权益 / IM | /account | <1.20警告、<1.10紧急；参考目标1.30 | 限制新暴露，补资金或协调缩仓 |
| 2. Gate 清算健康度 | `gate.mm_health_ratio`，净权益 / MM | /account | <2.00警告、<1.50紧急 | 优先保证账户持续偿付能力 |
| 2. 钱包借款 | `gate.liability_usdt`、`gate.liability_usdc`、`gate.interest_daily_usd` | /account、/rebalance实时利率/利息 | 借款非零警告；利息达到预计日收益10%警告 | 核对负权益和计息规则，检查Rebalance或补资金 |
| 2. 清算距离 | `gate.liquidation_distance_pct` | 官方/终端模型，必须明确模型假设 | <30%警告、<15%紧急；模型不可用UNKNOWN | 结合MM、借款与价差决定补缓冲或缩仓 |
| 3. ETH抵押品价格暴露 | `collateral.eth_net`、`collateral.eth_delta_usd` | Boros净余额和所有额外对冲，不只两条永续 | 未核实额外对冲UNKNOWN；20%跌价压力损失>本期净收益警告 | 单独记录抵押品汇率损益，明确是否接受该敞口 |
| 3. 美元压力损失 | `collateral.stress_loss_usd`、`collateral.stress_loss_profit_ratio` | 已配置ETH跌幅压力情景，不是实时预测 | 压力损失超过预期策略收益警告 | 调整敞口/资金配置，重算收益与风险 |
| 4. 永续标记价差 | `basis.mark_spread_usd_per_eth`、`basis.pnl_usd` | /positions两腿mark/entry/qty | 价差损失>预计净收益25%警告、50%紧急 | 查持续性与盘口，结合保证金决定协调缩仓 |
| 4. 实际退出成本 | `basis.executable_exit_cost_usd`、`basis.depth_coverage_ratio` | 双腿盘口按实际数量吃单估算 | 退出成本>剩余收益25%警告；深度不足UNKNOWN/警告 | 不用标记价替代成交价；控制双腿执行间隔 |
| 5. 永续数量中性 | `hedge.perp_net_eth` | /positions实际signed qty | 超过交易最小步长容差且持续两轮警告；大额立即紧急 | 核对订单与成交后处理残量，禁止盲目重复下单 |
| 5. 每条资金费腿匹配 | `hedge.hl_size_gap_eth`、`hedge.binance_size_gap_eth`、`hedge.direction_match` | asset-view与交易所实际持仓；逐venue核对方向 | 超过配置容差警告；方向错立即紧急 | 协调修复对应腿，避免只看总净delta |
| 5. 期限匹配 | `hedge.maturity_match`、`hedge.market_identity_match` | Boros市场描述/持仓maturity | 不同到期日或标的/资金费市场错配紧急 | 暂停扩大规模，核对原始成交 |
| 5. 执行残留 | `execution.unhedged_eth`、`execution.halted_count`、`execution.pending_age_s` | /deals、/alerts、/orders/open | HALTED/异常裸露紧急；待确认超配置时间警告 | 查真实订单状态，不把超时当作未成交 |
| 5. 非预期减仓/ADL | `positions.unexpected_change_eth`、`positions.adl_event_count` | 持久化基线+成交/ADL记录；记录不全UNKNOWN | 无授权基线更新的仓位变化紧急 | 核对是否清算/ADL，重建四腿对冲 |
| 6. 到期提醒 | `rollover.days_to_maturity`、`rollover.plan_confirmed_at` | 实际maturity、人工展期/退出计划时间戳 | ≤14天提醒；≤7天未确认计划警告；≤1天紧急 | 准备展期和退出两套方案 |
| 6. 下一期机会 | `rollover.next_net_apr`、`rollover.depth_coverage_ratio` | 实际size模拟/盘口及两腿全部费用，不只mid | ≤用户最低收益线警告；深度不足或无配对UNKNOWN/警告 | 不为省手续费强行展期 |
| 6. 重叠保证金 | `rollover.incremental_margin_usd`、`rollover.post_roll_coverage` | 模拟旧/新仓共存阶段的保证金 | 达不到各侧管理线警告 | 预留展期抵押品；逐笔确认新旧仓 |
| 6. 资金费对冲空档 | `rollover.uncovered_funding_seconds`、`rollover.uncovered_funding_eth` | 永续存在且对应Boros不存在/已到期 | 空档立即警告；超过配置时长紧急 | 建立正确下一期对冲或执行既定退出方案 |
| 6. 市场交易限制 | `market.trading_status`、`market.last_status_verified_at` | 完整官方市场状态；不能仅用pair context筛选结果 | close-only/makers-only/capped警告；halt紧急；状态不可核实UNKNOWN | 准备受限市场的退出/展期替代方案 |
| 7. 数据新鲜度 | `data.age_seconds`、`data.stale`、`data.coverage_complete` | 各接口meta+底层账本覆盖/mark陈旧字段 | 超过source TTL或覆盖不全UNKNOWN并通知 | 不依据过期信息继续扩大仓位 |
| 7. API与执行服务 | `service.http_ok`、`service.consecutive_failures`、`service.last_success_age_s` | /health及认证只读接口、/deals | 连续失败两轮警告；交易执行异常紧急 | 查网络/进程/订单，保持恢复证据 |
| 7. Boros授权 | `agent.approval`、`agent.expiry_days` | /boros/agent live approval/expiry | ≤30天提醒、≤7天警告；expired/revoked紧急；unknown为UNKNOWN | 提前更新授权并验证，勿等待退出时才处理 |
| 7. Gas余额 | `agent.gas_balance_usd` | 原始官方gas-balance或已有只读通道 | <配置所需操作预算警告；不可读UNKNOWN | 在本机确认交易gas预算与充值方式 |
| 7. 监控自身存活 | `monitor.heartbeat_age_s`、`monitor.last_complete_run_at` | 进程外监视读取心跳，不由自身保证 | 超过两轮预算警告；全机失联由外部通道通知 | 查监控服务与主机，不把未运行当作正常 |
| 7. Telegram送达 | `notify.last_success_at`、`notify.pending_count`、`notify.failure_streak` | Telegram确认返回+本机持久化队列 | 失败保留待发送；连续失败输出本机紧急状态 | 重试并保留日志，恢复后补发；隐藏token/chat id |
| 8. 稳定币价格 | `stablecoin.usdt_usd`、`stablecoin.usdc_usd`、`stablecoin.source_age_s` | 独立USD报价，不能把USDT/USDC价恒设1 | 偏离>0.5%警告、>1%紧急；缺可靠USD源UNKNOWN | 评估实际权益和退出/转账通道 |
| 8. 托管事件与提现通道 | `custody.incident_status`、`custody.review_age_h`、`custody.withdrawal_status` | 官方公告+带证据的人工核查；不自动提现测试 | incident紧急；最近核查>24h待核查；提现未知UNKNOWN | 不扩大托管规模，确认可执行的资金访问路径 |
| 8. 协议/预言机事件 | `protocol.incident_status`、`protocol.review_age_h`、`oracle.settlement_lag_s` | 官方事件核查+实际settlement epoch进度 | incident紧急；错过两次预期结算加宽限期警告；>24h未核查待核查 | 对照实际结算与公告，保持备用资金 |

## 输出与通知契约草案

每项输出：id、风险类别、状态（OK/WARNING/CRITICAL/UNKNOWN）、value、unit、threshold、source、observedAt、ageSeconds、coverage、reason、recommendedAction。JSON与人类可读表均需支持。未经确认的阈值必须在报告中标明。

UNKNOWN 不与数值严重度混在一个分数里；采集失败不能覆盖先前尚未解决的CRITICAL。行情提醒需去抖和解除阈值，方向错/仓位缺失/到期失去对冲不可因去抖延迟处理。告警只有发送成功才能记为已通知。

## 尚待验证的来源

官方 Boros 维持保证金/完整市场交易状态/gas读通道、交易所ADL流水、下一期真实size模拟、独立稳定币USD报价、托管公告与人工记录、进程外失联报警。未取得有效数据时输出UNKNOWN；不能用当前快照硬编码未来状态。

已核实的实现限制：`meta.ts`只是响应时间，应优先使用上游更新时间、陈旧标记和覆盖证据；`/health`只证明HTTP服务响应。pair context筛选部分非正常市场，不能据缺席推断状态。余额重建必须按抵押品组分开并核对挂单占用，优先读取完整Boros账户。现有Boros成交数据不能可靠归因ADL，先报非计划仓位变化。`/books`仅提供顶部报价，不能冒充完整退出深度。现有稳定币价格恒设1，脱锚指标需独立USD源。gas可经只读simulate获取，绝不能为采集调用execute。
