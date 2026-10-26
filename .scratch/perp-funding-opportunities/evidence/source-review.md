# 永续两腿机会页：本轮事实核查

2026-10-27；只读代码核查。没有访问实盘、读取凭据、改服务或测试下单。

## 已有入口与收益模块

- `web/src/App.tsx:227,265` 已有独立 funding tab，挂载 `FundingSpreadsPanel`。用户已决定升级此入口，保留四腿/三腿机会入口。
- `web/src/panels/FundingSpreadsPanel.tsx:89-208` 当前只读：当前费率年化、回本天数过滤、每币种报价展开、stale/partial/assumed-fee 提示；没有下单接线。
- `src/server/routes/fundingSpreads.ts:60-120` 已有 `GET /api/funding-spreads`，以 CrossEx live FUTURE 合约作为 universe，读取各 venue 公共 bulk feed，账户费率读取失败时显式 VIP0 fallback；返回 feed 状态、最旧输入 observedAt、stale 和 coverageComplete。
- `src/core/funding/feeds.ts:145-159` 当前 bulk feeds 为 BINANCE/ASTER/OKX/BYBIT/GATE/HYPERLIQUID/KRAKEN/LIGHTER。它们不是完整历史资金费接口；不要把已有当前费率当作已有7—365天生产历史服务。
- `src/core/funding/spreads.ts:93-147` 当前每个 underlying 只选当前APR最高/最低的一对，未枚举所有有向 venue pair。按当前利差排序，`roundTripFeeRate` 只含两腿开平 taker 手续费，paybackDays 不含滑点、基差、借款。
- 同文件 `:54-64` 做1000/k/1M等名字归一化，`:77-83` 以价格中位数剔除异常同名资产。名字加价格容差不能单独证明可执行的经济资产同一性、合约乘数及结算币转换。

## 历史研究与生产边界

`scripts/funding_research/README.md`、`common.py` 与 `venue_*.py` 已有六场所历史读取器、离线清洗/缓存和研究数据；不等于所有 CrossEx 场所、全部币种、当前时点均有完整历史。不得把研究候选固定30币、旧清洗结束日期或一次回测统计当成生产实时支持集合。

本会话上一轮五窗口统计提供了同一截止点、实际逐期费率加总及缺口验证的例子，见 `data/funding_research/reports/eth-hl-binance-windows-2026-10-27/analysis.md`。生产设计仍需决定缓存刷新/覆盖契约及数据源边界。

## 下单与风控

完整路径证据见 [执行复用核查](execution-reuse.md)。重点：

- 可复用 `TradeFlow.prefillPair → PairTicket → preview/finalizeActions → ExecuteControl → POST /deals → engine → DealModal`。
- 当前执行币种仅ETH/HYPE/BTC；用户已决定首版沿用，不扩大白名单。全市场观察不得直接受此白名单截断。
- 首版不支持不同合约计量单位/乘数的跨腿执行。不能把研究/扫描用的名字归一化直接当成可执行数量换算。
- 共用同一 venue 合约的四腿和两腿策略，实际永续净仓会合并；执行记录不是长期仓位切片/归属记录。
- `web/src/lib/riskSources.ts:168-210` 现有旧测量仍有明确四腿/ETH语义；执行核查另定位了 account funding_unmatched 的 Boros coverage→CRITICAL 规则。尚未完整验证所有现场 producer 分支，不能断言每个纯两腿现场都会报警；必须用合成纯两腿、四腿和混合切片案例定界。

## 验证范围

结构核查采用 codebase-memory Tier2；项目 `home-jerel-workspace-GitHub-arbitrage-with-crossex`、generation `2026-10-26T15:21:10Z`。图搜索/trace 配合源码读取；上列生产源码均做 exact-path coverage，metadata_match/no_recorded_issue。clean 只是 best-effort 信号。子核查的路径、已读范围及限制见其证据文件。

当前分支为 `research/funding-spread-crossex`；本轮不切分支、不实现、不提交、不推送。真正开发应按仓库约定从dev建立实现分支，保留研究分支与研究缓存。
