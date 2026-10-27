# 工单04 Risk静态事实核查（2026-10-27）

范围：只读当前源码、现有离线测试定义；未读.env/账户文件，未调用服务/实盘，未运行全套或新增测试，未改仓库。以下是确定的源码分支推演，不是现场状态或自动分配方案。
核查工作区：`arbitrage-with-crossex-perp-funding-opportunities-docs`，分支`docs/perp-funding-opportunities`，基准`1c7cb74`。以下为现有事实与缺口，产品决定以工单04的Answer为准。

## 1. 实际调用链及consumer差异

- UI：`web/src/panels/RiskPanel.tsx:22-27,35-55` 建立 `pool: account`，读取完整历史asset-view及共享account/positions/collateral等，调用 `riskMeasurements → evaluateRisk → visibleRiskChecks`；其previous critical是页面本地ref，刷新可重置。
- HTTP：`src/server/routes/riskReport.ts:31-65,74-98` 同样强制 `pool: account`，通过app.inject组合真实GET producer，服务器内 `riskMeasurements → evaluateRisk → visibleRiskChecks`；可接受并校验客户端previous状态。complete要求适配后data.coverage_complete为true且所有读无errors；返回note明确UNKNOWN不是安全。
- 共享适配：`web/src/lib/riskSources.ts:355-369` account分支最后调用 `accountRiskMeasurements` 并覆盖同名metric。不能用其较早ETH-cross/pair代码直接推断当前report行为。
- 策略评估：`src/core/risk.ts:95-101,154-225` 只有带account override的规则才换成account语义。所有启用规则仍计算，但UI/report隐藏risk=8、hedge.market_identity_match、positions.unexpected_change_eth；因此不是所有catalog规则都会展示/通知。
- Python常规后台：`scripts/risk_monitor.py:342-374,397-401,1038-1043,1059-1088` 从 `/api/risk/report` 取同一份checks/state，保存通知/健康/连续历史；共享报告不可用转unavailable_report保留不可验证危险（817起）。`evaluate` 的441-442行明确是历史fixture保留的离线旧评估器，常规service不调用。不能把旧Python evaluate规则推断成第二套当前现场报警器。
- Python独立工作仍包括：通知队列/heartbeat/连续funding-gap时钟；显式 `--accept-baseline` 走旧collect，见316-339、1039-1057；不是业务Risk当前规则的独立完整实现。

## 2. measurement producer、scope、单位、完整性

- `RiskScope` 仅credentialId/address/accountId/pool（`src/core/risk.ts:11-12`）；当前核查的价格净敞口和funding匹配循环没有策略ID/意图/账簿分配作为输入，取实际账户positions及钱包Boros。不能在这些循环中表达“这0.3属于纯两腿、其余属于旧四腿”。
- 账户producer `web/src/lib/accountRiskSources.ts:47,59-108` 白名单仅ETH、BTC。read要求相同credential、非placeholder、非error/stale、producer时间不在未来且≤120秒；Boros还验证address/accountId、risk version=2、positionsComplete、唯一marketAcc+marketId、池身份、正sizeBase、方向/venue/maturity。perps核验原始row与exposure一一对应、唯一symbol、数量/符号完全一致、quote=USDT/USDC/USD、无held/stale mark，且全部非零持仓base都在ETH/BTC。
- 因此HYPE非零仓会使本producer的perpsComplete=false；即使其余ETH/BTC已知，相关账户净敞口/权益PnL覆盖/资金费匹配转不完整。不是把HYPE量误当ETH；也不是HYPE已支持。
- 上游 `src/server/routes/assetView.ts:1380-1436` 从所有cross/isolated实际marketPositions构造risk v2，每market只放一次，保留marketAcc/marketId/base/tokenId/spreadVenues；notionalSize以18位整数解析，方向来自符号；sizeBase是正十进制字符串，仅ETH+token2或BTC+token1能够赋值，否则null；未知market/base/token/maturity令positionsComplete=false。观察时间取market/collateral最早时间，stale照传。
- `src/core/risk.ts:134-150` 继续核验metric合同类型、单位、exact scope、source/evidence、producer时间和min(TTL,contract TTL)、complete。无证据不是0；无效值通常置null；known bound可保留危险方向；`166-225` 缺metric从UNKNOWN起步，可被已知warning/critical覆盖；以前critical不能验证时保持CRITICAL。UNKNOWN不能解释成安全/全局豁免。

## 3. 两种风险明确分开

### A. 永续价格风险（不要求Boros存在）

`accountRiskSources.ts:121-148`：逐ETH/BTC求有符号perp净数量；每币选择全部fresh持仓中最高mark，以abs(net)*mark估残余USD；币间USD相加，ETH和BTC不互相抵消；再除正Gate marginBalance。
`risk-monitor-rules.json:457-479`：账户价格净敞口 `residual_equity_ratio >0.001 WARNING; >0.01 CRITICAL`。等号不触发。两腿等量反向可净零，即便没有Boros；不证明策略分配/经济收益/账户整体安全。
`riskSources.ts:41-49` Gate IM/MM覆盖=marginBalance/IM或MM，要求margin>0；0的比率未定义，不能当无限安全。规则 `risk-monitor-rules.json:213-258`：IM<1.2 WARNING/<1.1 CRITICAL；MM<2 WARNING/<1.5 CRITICAL。这组共享account指标不会被account adapter覆盖。
`riskSources.ts:84-103` 条件清算距离使用account+positions调用liquidationLines（不是按rule.sourcePlan字符串再取API）；需要完整有限价格/数量和无unknown线。模型说明一币移动其余不动、无未来funding/利息/venue gap，缺tier可用当前margin-rate回退。规则287-307：绝对move<0.3 WARNING/<0.15 CRITICAL。这些数量/保证金/清算风险与Boros coverage不同，不能一起豁免。

### B. Boros资金费覆盖风险（保留旧策略语义）

`accountRiskSources.ts:252-282`：单市场Boros原样一条；Spread仅在coverage中展开为首venue同side、次venue相反side。collateral/PnL/maturity仍每market一次。venue源必须可验证：普通venue是大写字母数字；Spread必须两个不同合法venue。现有fixture定义 `riskSources.test.ts:100-128` 明确覆盖Spread方向顺序，错误/重复来源UNKNOWN；这是读到的测试定义，未执行。
匹配按 `base:venue:side` 聚合全部perp和未到期Boros `sizeBase`；无“两条Boros”的前提，可同时包含普通四腿、Spread三腿、Spread+singles、多市场/到期，只要输入可验证。当前以来源/方向汇总，无法证明单个策略/到期一对一归属。
每来源gap=actualPerp−liveFunding；ratio=abs(gap)/actual，有Boros无perp则ratio=1；任一来源一侧有量另一侧0即funding_unmatched=true（包括tiny orphan，不走$10/lot豁免）。方向错误独立识别同来源只有反方向Boros。
`accountRiskSources.ts:283-319`：缺口美元采用已验证该base最高mark；`funding_gap_usd`取各来源绝对gap美元最大值（不是总和）。只有gap>$10且gap大于一个已验证可执行lot才进入material ratio；lot证据缺失不提供lot豁免。`risk-monitor-rules.json:525-563`：material ratio>0.001 WARNING、>0.01 CRITICAL；direction_match=false或funding_unmatched=true独立CRITICAL。`src/core/risk.ts:171-179`不将旧固定ETH阈值错误重解释成新比例；自定义兼容阈值仍强制附加direction/unmatched条件。
`accountRiskSources.ts:323-342`：rollover.uncovered_funding_eth只累加ETH各来源正gap，BTC不混ETH；hl/binance_size_gap_eth仍是ETH且取对应venue最大绝对gap，新account规则不再用其旧固定ETH阈值。funding_gap_ratio/USD/details支持BTC自身单位。

## 4. 场景可表达/不可表达（条件推演，非现场结论）

| 场景 | 当前能表达 | 当前不能表达/限制 |
|---|---|---|
| 纯两腿ETH/BTC，完整已知空Boros | perp净价风险可为0；funding_unmatched=true，使“每条资金费腿匹配”CRITICAL | 不能说该无Boros是策略有意，不能自动豁免；不代表所有Risk均报警 |
| 纯两腿但钱包/完整Boros证据缺失 | perp净敞口仍可独立有效；funding匹配UNKNOWN，旧critical可留存 | 不能由没读到Boros推断无Boros，更不能UNKNOWN当安全 |
| HYPE两腿或账户混入非白名单非零仓 | 共享account IM/MM等仍按其producer证据判断 | 该accountRisk producer价格净敞口/匹配不完整；没有HYPE币种泛化 |
| 普通四腿、Spread三腿、Spread+singles | 账户coverage按base/venue/side聚合，Spread正确展开且不重复MTM/抵押 | 不知道哪条策略拥有哪份数量；不能仅因全账户覆盖量相等推断所有策略各自满足策略规则 |
| 纯两腿+旧四腿混合/未归属 | 能观察全账户净暴露、来源funding缺口、独立抵押池风险 | 没有策略归属；旧Boros可以在同来源聚合中覆盖新增perp，未覆盖纯两腿会触发同一旧覆盖语义。不能自动认领/全局豁免，也不能用相抵账户净量证明无残余策略风险 |

## 5. 不能概括为“全Risk支持”的分支

- `riskSources.ts:156-164,212-254` 的basis.mark_spread/PnL仅ETH HL/Binance；loss_profit_ratio要求恰好两个perp、两条单市场Boros、指定方向/同到期、0.001 ETH容差和完整历史fee、deriveAsset恰好一个四腿pair及正到期利润。无Boros、Spread、多组合、其他币/venue不会获得该分母的有效值，通常UNKNOWN。该指标有明确注释禁止supplement用旧collector baseline覆盖（339-340）。
- `RiskPanel.tsx:36-40`、`riskReport.ts:66-70` opportunities触发先要求boros.length==2、相等sizeToken、token2价格、14天内和baseline；`riskSources.ts:310-324` 后续仍旧pair与ETH HL/Binance/精确baseline限定。不能把account coverage对Spread支持外推为rollover quote支持。
- `src/server/rolloverEvidence.ts:58-66,82-87` 的batch readiness producer仅支持一个预设ETH watch方案及配置匹配，不是任意两腿/四腿/Spread通用producer；本次只核查该入口scope，未重审整个watchProgress或执行链。
- `accountRiskSources.ts:343-359` maturity取物质Boros最早到期、$10以下dust不设时钟；完整空Boros的days=null且不标NA；只有全为dust时NA。data.coverage_complete还要求Boros/collateral/settlement/PnL完整（355-357），不是“perp已对冲即完整”。

## 6. Python剩余ETH专有历史与兼容限制

- `risk_monitor.py:361-374` shared report可pool=account但仍要求配置base=ETH、collateral_token_id=2、同wallet/account/credential和≤120秒report；不能直接宣布monitor任意币通用。
- `risk_monitor.py:47-87` 独立record_funding_gap只认account0、ETH perp、特定ETH token2 cross池，Boros venue白名单HL/Binance/OKX，并用sizeToken/float。含BTC池、isolated、其他venue或Spread复合venue会清funding_gap；没有按spreadVenues展开。更严限制不污染当次account coverage，但导致ETH持续空档时钟无法获新证据。
- `accountRiskSources.ts:329-338` 只有scope/fingerprint/缺口完全匹配、历史≤3600秒才能算连续seconds；无历史而有缺口时seconds=null，不由页面访问启动计时；uncovered量仍可已知告警。`risk-monitor-rules.json:759-780` ETH uncovered>0.001 WARNING；seconds>300 CRITICAL。所以只有完整无Boros+有ETH时可推unmatched严重，但不能无条件声称持续时长严重。
- `riskEvidence.ts:74-91` supplement的真实producer scope还验证Gate user、root/subaccount、ETH/token2、terminal/config hash；不合scope的观察不进入metric。`1059-1066` monitor只有report.complete才延续历史；不完整即清history。其通知/健康状态独立，不等于旧evaluate在线运行。

## 7. 核查覆盖与限制

Tier2 graph：收到父级evaluateRisk search全19结果/两页和双向depth1 trace；本轮accountRisk相关search 23、assetView相关25、rolloverEvidence3均has_more=false；accountRiskMeasurements双向depth1 caller=riskMeasurements、callees22；buildAssetView双向depth1 graph匹配有42callees；关键分支定点源码补读。snippet工具end_line未约束返回，我没有用被截去的内容代替源读。
所有依赖路径check_index_coverage共14条：src/core/risk.ts、src/server/routes/riskEvidence.ts、riskReport.ts、assetView.ts、src/server/rolloverEvidence.ts、src/core/boros/client.ts、venue.ts、web/src/lib/riskSources.ts、accountRiskSources.ts、riskSources.test.ts、web/src/panels/RiskPanel.tsx、scripts/risk_monitor.py、risk-monitor-rules.json、risk-monitor-metrics.json；均generation=2026-10-27T00:02:21Z、metadata_match/no_recorded_issue、无recorded gap。此为best-effort，不是全仓穷尽保证；无全局负面结论。
未核实：现场scope、已有配置threshold override、通知当前去重状态、实盘实际measurement/status、未知/未归属仓的产品分配政策、新纯两腿准入应采用何风险规则。以上必须保留UNKNOWN或交工单04产品决策，不能自行选择豁免/自动认领。
