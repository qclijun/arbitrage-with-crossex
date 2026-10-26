# 永续两腿执行复用事实核查（只读）

核查日期：2026-10-27。没有实现、启动服务、读取凭据或调用实盘。

## 结论

现有引擎已经表达“一币、不同合约、等量、方向相反的两腿永续”，不硬编码某一 venue 配对；可复用其创建、maker 部分成交后的 hedge、异常对账及执行回显。这里的 venue 范围是 **CrossEx 返回且 state=live、businessType=FUTURE 的合约**，并受服务端币种白名单限制；不能据此声称支持任何外部交易所/API。

它保证按 A 成交量追 B，并非同时成交或每一时刻严格等量。不同步长/最低金额、部分成交、拒单等可以留下暂时风险或最终 dust；“DONE”并不必然等于满目标且零差额。

## 已存在的执行路径和入口

- `src/engine/types.ts:20-47`：LegSpec 只有 contract、side、lot/minSize/minNotional/tick、reduceOnly；PairRow 的 A 是 maker/acquiring，B 是 market/IOC hedge，只有一个 targetQty。接口无固定 venue 对。
- `src/engine/create.ts:86-173`：用 CrossEx rules 查两合约，必须 live FUTURE、不同 contract、同 base；凡会新增风险的双腿必须相反 side；共享 qty 必须为两边 lot 整数倍并满足各自最小数量。
- `src/server/routes/deals.ts:104-145`：POST `/deals` 检查免责声明、客户端 id 去重、币种支持、运行中 rebalance/transfer；调用 resolveDeal。`:150-231` 处理杠杆设置/确认/失败回退。`:230-234` 写入 pair、wake、返回 202；202 是接受意图，成交在后台进行。注意文件顶注释“route never touches mutating endpoints”与实际杠杆设置存在差异，应依实际源码评估。
- `web/src/trade/PairTicket.tsx:217-271`：已经有独立双腿票据，选择 long/short symbol，market 或 maker 模式；同一 pairGroupId 串起预览。maker 根据 maker+taker 费率组合自动选择 long 或 short 为 maker，当前无手动覆盖（文件头也明确此点）。`:150-188` 可接收 base、longVenue、shortVenue、notionalUsd/sizeBase、sizeUnit、mode 的 prefill，并把 venue 映射为该 base 的规则合约；不可映射则为 null。
- `src/core/actions.ts:381-449`：同 group 的两个 open action 经过 shared sizing，两边必须相同单位/相同输入量；把共享 lot/min/minNotional 约束交给 resolveQty，回填同一个 qty，失败提供 lot-incompatible 等 violation。
- `web/src/trade/deal.ts:30-59`：一 maker open-limit + 一 hedge open-market 映射成一个 maker DealRequest；`:78-93` 两个 open-market 映射成 taker pair，共享 qty。该路径的两 market 也经 A clips/B hedge，不能引用 PairTicket 文件头“concurrently”的旧注释解释当前实现。
- `web/src/trade/ExecuteControl.tsx:225-301`：确认要求当前 preview，超过 10 秒、估算中、预览错误/violation、已知保证金不足、无法映射等禁用；confirm 时 finalizeActions 后映射为 deal。`:143-159,321-325,342` POST `/deals`，成功 openDeal，按钮为 800ms hold；客户端 id 在发请求前持久化，同意图失败重试保留 id。
- `web/src/trade/TradeFlow.tsx:234-239`：现成 prefillPair 会预填票据并展示 rail；`:265-271` openWizard 则进入四腿策略流程并清掉 rail prefills。
- **当前机会页不是直接两腿入口**：`web/src/panels/OpportunitiesPanel.tsx:1104-1134` 的 openStrategy 调 `flow.openWizard`，同时传 Boros long/short、maturity、route，以及 CrossEx long/short、notional/sizeBase、perpMode。因此未来纯永续机会卡可否走既有 prefillPair 是待产品决定的连接点，不能把现有卡误描述为已直接创建两腿 deal。

## 部分成交、量化和失败的真实语义

- `src/engine/decide.ts:29-75`：projection 按本 deal 的订单注册表折叠 A/B fills；unhedged = A filled − B reserved。B pending/open 的全委托量算 reservation，所以界面 unhedged=0 并不证明 B 已全部成交。
- `src/engine/decide.ts:79-95`：hedge 向下取整到 B lot，低于 minSize/minNotional 为零；需要 minNotional 参考价但读不到时返回 null 等待。目标 qty 能同时整除两 lot，不代表 maker 每一个部分 fill 都够 B 的 lot/minimum。
- `src/engine/decide.ts:290-355`：hedge catch-up 在各 live mode 优先；B 为纯 MARKET IOC，依 venue 自己的价格限制，不采用用户自定书本价差带。连续 hedge 拒单达到阈值进入 HALTED；`src/engine/types.ts:326` 阈值为 3。HALTED 取消 maker、停止增加 A，仍可慢速 hedge 重试；STOPPING 也先 hedge 已成交部分再结算。
- `src/engine/decide.ts:174-203`：只有全部订单已结算且剩余 hedge 已证明不可提交才 finish；最终报告明确未买到 residual、unhedged dust。不可因 DONE 自动宣称完全对冲。
- `src/engine/create.ts:185-254`：两边 minNotional 以 refA 最佳努力预检；总 qty 不得超过 A market cap、maker 的 A limit cap、B market cap。B 未实现超限拆单，故直接拒绝过大目标。
- `src/engine/create.ts:293-301`：普通 maker pair 默认 300 秒后转 taker，四腿 best 家族默认 1800 秒；全局 30–3600 秒。`:334-359` 创建做 margin preflight，但读取失败为 fail-open，已确认余额不足才阻断。
- `src/engine/loop.ts:1-4,391-434`：单写 reconcile，一 tick 最多一次 wire mutation，注册 PENDING 在提交前；`:89-156` 处理数量下降、不可识别状态并隔离，不会当成正常成功。没有独立的新 recovery 机器需要另造。

## 回显与持仓归属的边界

- `web/src/trade/DealModal.tsx:1-4,143-160`：dealId 订阅执行；关 modal 不影响后台。`:213-230` 显示 timeout、unhedged 和 pending/quarantine；`:300-363` 有 convert/re-peg/stop/resume；`:447-476` 显示 A filled、B hedged、dust、reason；`:97-141` 可以按合约 venue/方向和两平均成交价展示 entry basis。
- `src/server/routes/deals.ts:73-79,237-248`：已有 deal 列表和单条 projection/orders/progress 接口；可以重新打开同一执行。它是“执行记录”，不是独立分配的持仓账。
- `src/engine/types.ts:42-113` 的 PairRow 只有 execution identity/intents；`src/engine/db.ts:207-223` DealFillReportRow 有 dealId、两合约/方向/成交/均价，可作为某次执行对入场成本的贡献。**这些被核查类型没有 opportunityId、策略 owner、持仓切片或每策略独立平仓权益字段。**
- `src/engine/create.ts:255-274` reduce-only 校验基于 CrossEx 当前合约净持仓，按 contract 查找，而非按某个机会/某次 deal 的剩余量。新增 open 方向若撞到现有反向净仓，可能首先抵消旧仓；deal 的等量新增订单不自动等于账户里新出现两笔独立归属持仓。账户持仓聚合/策略页分摊不在本子任务完整审计范围，不能宣称已经满足未来纯永续策略跟踪。

## 真正需要产品/规格决策（此报告不替用户选择）

1. 新机会页的 venue/合约支持集合和币种范围；是否明确只承诺 CrossEx 现可交易集合。
2. 执行按钮接现有独立 PairTicket 预填还是另一个受同一确认门约束的界面；保留哪些可编辑项、确认时以哪次机会快照为准。
3. maker 自动选边、普通 touch/固定价、300 秒 timeout 与到期转 taker 是否沿用；是否要求手动选 maker。机会页模拟成本必须与实际执行政策一致。
4. USD notional 与 base qty 的呈现/取整：两个相同 base qty 才是当前引擎保证，跨 venue 不保证两个完全相同的 USD notional。
5. 用户可接受的暂时 unhedged 与最终 dust/部分完成阈值；DONE、HALTED、STOP 的解释和操作入口。是否要求额外限制最大单腿暴露、用户可设 slippage（当前 B 是 pure market IOC）。
6. 同 base/venue 既有仓、同时运行多策略/重复点击的归属：是仅跟踪单次 deal，还是定义长期策略及剩余量、成本、退出动作。现成 idempotency 只去重同 id，不是机会级/长期持仓去重。
7. 是否需要机会卡保留 dealId 并关联执行后状态、在哪里长期显示执行报告，如何表示已有净仓被抵消和手动改仓；现成 DealModal 可回显执行，不等于这些产品要求已实现。

## 证据方法和覆盖

使用 codebase-memory Tier 2；index_status ready，generation/indexed_at=`2026-10-26T15:21:10Z`。先 search_graph 定位 DealModal/dealsRoutes/resolveDeal/project/PairTicket/ExecuteControl/TradeFlowProvider/dealFromActions，trace resolveDeal both depth 1（两页读完，12 callees、1 caller），再 get_code_snippet 和定点源码读取。dealsRoutes 的外层闭包 trace 无 callees，因此依真实源码补证，未推导无调用结论。

## 追加：全市场、倍率、Risk 的关键阻碍

1. **币种不是只有 ETH/BTC，但也绝非全市场可执行。** `src/core/coins.ts:1-9` 白名单精确为 `['ETH', 'HYPE', 'BTC']`，服务端 `/deals` 以原始 parseSymbol.base 校验。所以 HYPE 可通过，其他币种无法通过当前交易入口。扫描全市场和开放全市场交易须在规格中区分。
2. **现有票据 universe 更窄。** `src/server/routes/symbols.ts:64-87` 的 livePerps 限 live FUTURE、delistTime=0，再排除 BINANCE/OKX/BYBIT 的 USDC twins，再筛 ETH/HYPE/BTC。Hyperliquid USDC、Deribit/Kraken USD 不受 twin 排除。若新规格说“CrossEx所有可交易且历史完整组合”，现有 `/symbols` 不能直接作为完整扫描 universe；是否把这些过滤仅保留在现有 Boros 票据是规格问题。`resolveDeal` 自身不执行 USDC-twin 排除，而是读指定合约规则；因此不能把票据不可见与服务端禁止混为一谈。
3. **Underlying 同币归一化不等于执行支持。** `src/core/funding/spreads.ts:54-64` 只读扫描有 underlyingOf，支持 1000/10000/100000/1000000、1M、k 前缀及数值后缀；`:104-114` 把价格除倍率归一成每币。反之 `src/core/numbers.ts:169-182` parseSymbol 只拆字符串，`src/engine/create.ts:121-147` 比原始 base 且一个 qty 传两边，LegSpec 不存倍率，创建不消费 RuleSymbol.contractSize。`symbols.ts:48` 返回 contractSize 也不等于执行已使用。因此 `PEPE` ↔ `1000PEPE` 等原始 base 不同会被 create 拒绝；放宽白名单仍不能得到正确的两腿数量换算。未来若接受这类组合，需要定义 underlying数量、各合约数量、共同步长、价/金额基准与账户回显单位，不能直接把 shared qty照搬。此结论限已检查执行路径，不否认估算订单簿内对 Gate/OKX contract-size 的既有转换（它解决的是书本单位，非此处命名倍率双腿数量）。
4. **现有 Risk 带 Boros 覆盖预期，存在与纯永续策略冲突的确定规则。** `scripts/risk-monitor-metrics.json:93-96` 定义 funding gap 按 base/source/side 比 perp 与 Boros coverage，funding_unmatched 明确是“有 perpetual 却无 live Boros funding coverage，或反向”。`scripts/risk-monitor-rules.json:525-562` 的 account 规则把该 bool=true 或 direction_match=false 判 CRITICAL；`src/core/risk.ts:171-176` 对自定义阈值也保留这两项条件，`:192-204` 照实际 metric值评估。故新的纯两腿 venue资金费策略有被报“缺 Boros”的规则冲突，不应直接对其复用“每条资金费腿匹配”的成功含义。
5. **Risk 结论的限制。** 本次未完整追到上述 funding_unmatched 的 live measurement生产者（全局定点搜索仅定位合同、规则和evaluateRisk）；不能宣称所有venue/币种在现状一定实际报CRITICAL。`scripts/risk_monitor.py:603-619` 的旧路径也有预期 Boros 缺失时 direction_match=false，并依实际signed perp/Boros方向判断。需要父规格另设风险适用范围工单，优先沿 `src/server/routes/riskEvidence.ts`、`src/server/routes/riskReport.ts` 和其数据输入继续核查，不凭此报告宣布全Risk兼容。
6. **共享净仓归属缺口依然存在。** 执行参数没有策略所有者/切片权益，reduceOnly按venue合约当前净仓上限校验；两个策略复用同一perp净仓时，成交属于哪个策略、手动改仓后谁减量、平仓是否吃掉另一策略的仓位，均须定义。不能用dealId成交日志替代这些归属规则，也不能仅给新两腿策略屏蔽Boros报警而让共享风险失真。

追加依赖的 coins.ts、numbers.ts、symbols.ts、funding/spreads.ts、risk.ts、两个 risk-monitor JSON 均已 check_index_coverage：metadata_match/no_recorded_issue，并定点读源码；未审计的 riskEvidence/riskReport 仅作为后续路径，不作为本次证据。

对实际依赖文件逐一 check_index_coverage：DealModal.tsx、deals.ts、types.ts、decide.ts、create.ts、db.ts、loop.ts、ExecuteControl.tsx、deal.ts、PairTicket.tsx、TradeFlow.tsx、OpportunitiesPanel.tsx、core/actions.ts 均 `metadata_match/no_recorded_issue`，src/engine scope 无记录缺口。此为 best effort 元数据信号，不是完整性证明；关键结论已定点核对源码。未做修改，未运行测试，因为本任务是只读事实规划。

## 阶段交接（约300字）

目标是验证“永续两腿机会页”能否复用现有执行。已确认通用CrossEx同币种、异合约、反向、共享数量的maker/hedge及market流程；现有PairTicket、预览共量化、800ms确认和DealModal均可构成复用基础。当前机会页实际进入Boros四腿wizard，纯永续入口尚未连接。部分成交只按可提交步长追hedge，可能DONE带dust；B为market IOC，无跨腿原子成交保证。执行id及成交报告不能替代长期持仓所有权；与既有净仓、策略分摊的产品语义待定。无提交、无生产改动、无实盘访问。验证为Tier2图索引覆盖检查和定点源码，证据即本文件；父任务需纳入venue范围、maker政策、部分完成容忍、确认入口、持仓归属/回显等选择，不能提前替用户决定。
