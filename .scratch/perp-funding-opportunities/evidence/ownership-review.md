# 工单04：数量、归属账与生命周期事实（2026-10-27，只读）

范围：当前 CrossEx position→asset view、engine deal/order registry、现有数量切分与资金费/手续费证据。未读账户/凭据，未发服务请求，未实盘，未改仓库，未跑测试。Risk producer/规则链由其他协作者负责，本报告不涉及。此处只给已存在能力/缺口，不替用户回答产品决策。
核查工作区：`arbitrage-with-crossex-perp-funding-opportunities-docs`，分支`docs/perp-funding-opportunities`，基准`1c7cb74`。以下为现有事实与缺口，产品决定以工单04的Answer为准。

## 一、当前持仓是什么，不是什么

- `src/server/routes/positions.ts:28-38,56`：GET /positions 读取 CrossEx `listCrossexPositions`，经过 rememberMarks，原行与按 base 算的 exposure 一起返回；cache 有 stale/observedAt，支持 fresh=1。没有先按 dealId/strategyId 切分。
- `src/core/positions.ts:7-28,34-64`：ExposureLeg 是 symbol、exchange、quote、side、qty、value；parseSymbol 提取 venue/base/quote，positionQty/positionSide 认方向，qty=绝对数量；以 base 聚合 longValue/shortValue/netValue。它是净敞口展示，不是归属记录。不能把 same-base group 当一份策略。
- `src/server/routes/assetView.ts:600-608,1032-1066`：同一个 live positions feed，按 symbol 解析 venue、按 base 分组；保留当前净仓数量、entry/mark/leverage/uPnL、funding/fees、openedAt。内部可读 venue positionId 用于现金流去重，但输出 AssetPerpOpenOut（100-123）没有长期策略slice身份。不要强称 API 永远每symbol仅一行；这里的证据是应用按 venue/contract/position 的现有汇总行消费，不携带执行deal所有权。
- `assetView.ts:1-5` 明确说明该视图 No strategies/no enrollment/no maturity lifecycle。**有限结论**：在本次检查的 position route、asset builder 和下述 engine schema 中，没有可表示“一个长期策略切片跨多次加减仓deal”的持久实体或 allocation 关系；不是声称全仓库完全没有账。

## 二、已有 execution 账提供的强证据与边界

### 可复用

- `src/engine/db.ts:28-78` pair 表保留两腿 contract/side/reduceOnly、target_qty、mode、price policy、deadline、report_json、created_at；orders 表按 `(pair_id,leg,seq)` 关联，含唯一client_id、venue_order_id、委托qty、cum_qty、avg_fill_price、终态/原因、created_at/resolved_at。`src/engine/types.ts:42-107,110-142` 对应模型。金额/数量journal为decimal strings。
- `db.ts:500-526` 在事务内生成确定性 client id 并先写PENDING；`src/engine/loop.ts:391-435` 才wire。已实际观察的cum能无歧义归属到**该deal/腿/order**，未知状态继续占reserved，不猜成已填。03报告已有probe/quarantine细节，此处不重做全执行审计。
- `src/engine/decide.ts:29-75`：aFilled/bFilled=sum cum；PENDING/OPEN reserved=整笔order.qty，CLOSED reserved=cum，DEAD reserved=0。`residualA=max(0,target-aReserved)`，`unhedged=max(0,aFilled-bReserved)`。target是请求意图；reserved包含可能成交的在途量，**不能用来当已归属持仓或实际成交量**；执行中这个unhedged是扣掉预留hedge的投影，也不是`aFilled-bFilled`的当前实填差。filled才是执行观测，仍需考虑共享净仓的开平含义。
- `loop.ts:113-148` cum单调合并，缩小/未知状态alert+quarantine；保留avg fill price。`550-559` 完成时把aFilled/bFilled/unhedged/reason及按cum加权avg fill写report_json，mode=DONE；`decide.ts:163-172` report是本票执行投影。DONE意为该次执行收口，不能当长期策略已经平仓；本票可能完成后持有全部新仓，也可能持有dust残余（loop.ts:562-576明确警报）。
- `db.ts:609-630` avgFillPrice可重建该deal每腿加权成交均价；`639-685` 另有dealFillReports helper可导出DONE双腿的a/b实际filled、avg和createdAtMs；它剔除single、both-reduce-only exits，缺损/不可用report/非正filled或avg会跳过。该helper注释称用于strategy entry chain，但本轮search_graph与对src的literal引用查询只发现定义，无现行调用证据，不能宣称现有UI已自动重建长期策略。

### 不能直接推导

- `src/engine/create.ts:24-50` DealRequest只有新id、a/b合约方向reduceOnly、qty、执行/价格/期限/杠杆等，无strategySliceId、source/open deal、allocationId、Boros route关联。
- **部分成交**：可按order cum证明“本deal实际买/卖多少”，但PENDING/CLOSED不同状态仍须按上面规则；不能以target填满策略，也不能把单腿fill伪造为完整对冲策略。fill增量的时间仅有最新累计值/created/resolved，schema没有每笔venue fill事件时间序列或每次allocation生效时间。
- **加仓**：两个同向deal各有实际fills，可证明各自执行贡献；没有持久关系表把它们合并到一个长期slice、或约束与另一个策略共享同contract时各自份额。净仓同向增长也可能包含场外成交，不等于此策略加仓。
- **部分减仓/关闭**：`create.ts:251-275` reduceOnly仅验证当前contract活仓、相反close side、qty不超过活仓。它能保证当时不超过可减净仓，不证明减的是哪一个策略切片。`web/src/panels/assets/assetModel.ts:90-106,639-644` close helper会将当前展示pair的份额转成明确base qty；`web/src/panels/PerpOnlyBox.tsx:84-100` shared/typed partial关闭发送symbol+qty+slippage；无source slice/deal身份。故“两个各1 ETH切片净多2 ETH，减0.5 ETH”即使成交完全可证，现有记录仍不能唯一决定哪slice减了0.5。
- **反向净仓**：在one-way共享净仓上，一笔非reduceOnly BUY fill可能先减旧SHORT，而非全部形成新LONG。03已核对现有margin netting允许offset，不能仅按fill量给新策略记满qty。
- **场外净仓变化**：当前position是独立外部观测，engine registry只记录通过本engine的orders；没有本检查路径中的持久external-adjustment→slice关系或差额归属规则。可以识别“journal解释不了现仓”的矛盾，不能根据当前比例/最近deal/显示匹配自动猜分配。能否识别全部场外变化取决于完整历史与基线，缺证只能UNKNOWN。

## 三、保留/归档是否足以重建

- `db.ts:449-461,552-558` store可列全部pair/orders，activeOnly只是mode!=DONE查询；完成时是UPDATE pair，并不删除订单。对`src/engine`与`src/server`搜索`DELETE FROM pair/orders`及archive/prune deal，只见schema rebuild的DROP TABLE pair（377-419事务迁移），未见本路径主动裁剪execution历史。
- **有限结论**：当前engine DB看起来保留本机已入账的历史执行，不承诺永不丢失，也未审查备份、手工删库、旧版本导入及所有外部存储维护入口。即使这些pair/orders完整保留，因缺策略slice身份、每次allocation、关闭来源/外部变动归属和cashflow linkage，仍不能普遍重建长期策略仓位与PnL。
- `src/engine/observation.ts:38-52,89-91` 有带utc/mono时间的观察记录，但默认细节保留7天、100MiB且有丢弃/写失败计数；`src/server/index.ts:159-162` 仅ENGINE_OBSERVATION=1才启用。它是可选诊断补证，不能当永久归属账或必备venue逐fill时间真相（observation.ts:277也明确local application entry/completion不是network timestamp）。
- 有其他账：`src/server/ledgerStore.ts:43-60` 按address/subaccount持久化boros-ledger JSON；`src/core/boros/client.ts:920-952` settlement事件含marketId、timeSec、positionAbs、signed settlementToken/fee/rate、marketAcc与coverage。它证明Boros市场结算现金流，不是CrossEx净仓策略allocation。

## 四、4.03中0.36对应Boros的切分：确有，可复用数量逻辑

- `web/src/panels/assets/assetModel.ts:659-802` perpOnlyPairs对当前unpaired perps按多空venue配对，再按持有rate legs的实际数量切分；先匹配同到期双single，随后单single，余量无rate leg，含dust处理和no double claim的left/yuLeft账。`assetSplit.test.ts:113-126` 静态用例明确4.03分成0.36（已有Gate single）+3.67（纯perps），还有BTC base/SOL USD缩放场景。此为源码/测试证据，本轮未运行该测试。
- `assetModel.ts:605-636,764-784` partKey来自当前perp symbols、held market ids及本轮index，供UI区分parts；`perpOnlyCloseLegs:639-644`确实按slice qty关闭而非flatten整venue仓。可复用“保持总量、按覆盖量切分、显式关闭份额”的算法/回归用例。
- 但该函数无IO/持久化，输入是当前持仓派生数组；`deriveAsset:1312-1338`每次由group/exclusions/since/now重算，`1728-1744`还明确多种有效匹配时选择largest-first等稳定启发式。**展示匹配稳定不等于原始交易/策略身份真实**。场外改变或并仓后相同总量可以产生同一个显示结果，却无法恢复用户原分配。
- 现有资产模型区分spread与singles的实际Boros legs/maturity，不能把纯永续slice或其他route都硬编码成两Boros腿。父代理已核对ADR0002；本轮不重复其Risk含义。

## 五、收益归因的证据边界

- `src/server/routes/account.ts:45-55` /account原样返回账户级数据和stale/observedAt，不分slice。`assetView.ts:302-305`借贷利息明确ACCOUNT-level、按liability coin，不分market/slice。
- `assetView.ts:858-913` FUNDING_FEE account-book按`businessId`的positionId聚合，使用createTime过滤window；其事件金额是当期实际size对应现金流，可穿越净仓resize，**但不是策略slice的size时间线**。最多25页，截断warning；失败回退当前position whole-life cumulatives并warning。
- `assetView.ts:913-946` fill-history fees按symbol聚合（当前处理字段symbol/fee，没有slice关联），最多25页，截断warning，失败回whole-life cumulatives。不能从这一聚合结果分出同contract多策略费用。
- `assetView.ts:965-1003` trailing7d funding按positionId汇总，25页未完整结束直接null，短于1小时也null；annualize分母用当前notional，不是每slice完整历史权重。
- `assetView.ts:1032-1066,1070-1137` open行用positionId/window资金费与symbol/window费用；partial-close按**同positionId**对存活open cumulatives去重；close/reopen新id保留旧现金流。closed输出按symbol汇总、明细最多20行，历史position有其全生命周期数字。`1141-1145`将symbol费用window减去open已计部分后放closed。该逻辑解决账户/contract重复计数，仍没证明slice归属。
- `web/src/panels/assets/assetModel.ts:1483-1496`现有exclusions会按keep比例缩放open funding/fees，但注释明确closed/history不能pro-rata拆分，因为没有finished position份额归属证据。故不能把现有显示pro-rata当“已证实逐策略PnL”。
- Boros市场结算ledger有每期time/size/amount，但策略间共享marketAcc时仍需同期allocation证据；CrossEx资金费、手续费和Boros结算的覆盖可能不同。完整现金流+完整slice数量生命周期/归属关系缺一，金额按策略归因就不唯一。工单04可以复用既有位置/事件/执行账作证据源，**不能承诺仅凭当前净仓比例、APR或展示pair即可还原逐策略PnL**。

## 查询覆盖与未查项

- Graph project同任务指定，Tier2，generation=`2026-10-27T00:02:21Z`，recorded_at=`2026-10-27T00:07:54Z`。结构查询对Store/PairRow/OrderRow/LedgerStore、assets symbols做search_graph→trace_path→snippet；literal/config用rg和定点sed。初次泛搜asset symbols30/41和strategy54首屏仅作定位，没有据此作全库否定；定向assetModel、db methods、LedgerStore查询均完整页。
- 当前逐路径coverage：src/engine/{db,types,create,decide,loop,observation}.ts；src/server/index.ts；src/server/routes/{positions,account,assetView}.ts；src/core/positions.ts；src/server/ledgerStore.ts；src/core/boros/client.ts；web/src/panels/assets/{assetModel.ts,assetSplit.test.ts}；web/src/panels/PerpOnlyBox.tsx；docs/agents/architecture.md，共17路径，全metadata_match/no_recorded_issue，无reported missed ranges。best-effort，不证明图完整。
- 未查：实际账户净仓/成交/资金费数据、备份/手工导入的历史完整性、所有第三方/场外成交标识、现网是否启用观察、资金费API语义与SDK版本外部核验、所有其他存储模块。结论只覆盖本报告明示路径，无全库“没有账”或“永远可重建”断言。
