# 现有终端数据与脚本复用边界

核查日期：2026-10-07。仅检查本地代码；未联网、读取凭据、查询实盘或修改服务。结论是后续决策输入，不代表脚本实现或接口完整风险验证已完成。

## 已有计算与传输

- [Opportunity 模型](../../../src/core/boros/opportunities.ts) 已计算规模对应的成交利差、成本、四腿模型最低资金、净利润和资金年化；缺失关键输入传为 null。脚本应消费结果，不复制交易所行情与收益计算。
- [Opportunity 路由](../../../src/server/routes/opportunities.ts) 支持 close/roll、规模、入场方式和 fresh；读取账户费率失败时可降级 VIP0，并以文字 warning 报告。有限净收益不证明费率来自实际账户。
- Opportunity envelope 有聚合 `observedAt`、`stale`；`data.meta.asOfSec` 是构建时刻，不能替代输入新鲜度。请求回复统一通过 [app.ts](../../../src/server/app.ts) 带 `credentialId`，但不提供逐项上游费用来源。
- [risk_monitor.py](../../../scripts/risk_monitor.py) 的 request_json 默认无 payload 时是 GET，拒绝重定向；本身仍支持任意 URL 和带 payload 请求，没有专用于筛选的路径白名单。
- Collector.get 检查 ok 和 envelope stale，但不检查年龄、未来时间、钱包范围、完整性或 data.stale。它不能直接充当筛选证据验证器。
- 导入 monitor 不启动主程序，但会读取无关 metrics 契约；collect 会获取监控和外部 Boros 数据，主程序还会写锁、状态并可能通知。首版不调用 collect 或 monitor main。

## 可用证据及缺口

| 来源 | 可核查内容 | 不能由它单独证明 |
|---|---|---|
| Opportunity | 组合身份、规模、成本与净收益、模型资金、聚合最旧观察时间与 stale、请求账户身份 | 四腿成交、完整执行准备、逐项上游来源及费用机器可读状态 |
| account / positions | 当前永续账户、仓位及账户资金 | Boros 全部持仓、原子展期与安全预算 |
| Boros agent | 配置钱包及子账户、审批状态 | 页面是否另选了观察钱包；不应默默切换范围 |
| Boros collateral | address/accountId/observedAt/data.stale、逐抵押池官方可用初始保证金 | 价格来源的独立新鲜度、不同池可互相使用或完整压力风险 |
| asset-view 的 risk | 钱包/子账户、positionsComplete、observedAt/stale、当前 Boros 腿与入场信息 | 每一项上游源的独立时钟、目标换仓的全批成本与执行准备 |
| pair/context | 可配对市场及当前数量的辅助信息 | 全部持仓；会过滤已到期或不可配对市场，且未透出完整范围与缓存时钟 |

源码定位：[Boros 账户与 collateral/context](../../../src/server/routes/borosPair.ts)、[asset-view](../../../src/server/routes/assetView.ts)、[已有永续标签与费用覆盖](../../../web/src/panels/heldPerps.ts)。

## 后续决策的关键限制

1. 所有请求必须限制在验证过的 loopback URL 和预定义 GET 路径；token 不发送到外部 URL，拒绝重定向。
2. 开始及结束的 credentialId 应一致；Boros 地址/子账户必须匹配明确查询范围。缺少页面钱包选择信息时，不把配置钱包伪称为页面当前观察钱包。
3. 汇总响应时间、最旧输入时间和数据内时钟分别验证，close/roll 与持仓不是原子快照；不能仅凭返回成功认定新鲜。
4. 不把 pair/context 默认零数量或被过滤的市场当作“没有其他持仓”。
5. 返费未包含在服务端 Opportunity 数值中；如果纳入，须按当前有效返费及每市场适用性覆盖。未验证时明确不计或 UNKNOWN，不能默默采用 UI 假设。
6. collateral 的 USDT USD 价格可能为 null，不得擅自填 1；优先在原生单位逐池比较资金，未知转换仍为 UNKNOWN。
7. 无旧仓退出报价及换腿成本，换仓增益为 UNKNOWN。更晚到期、同方向的关系只证明续作候选，不证明原子滚仓 ready。
8. 模型最低资金条件不满足可以阻止目标规模；满足仅是必要条件，不能升级为安全投资建议。

## 离线验证参考

- [监控合成测试](../../../tests/monitor/test_risk_monitor.py)：fake Collector、远程终端在读取 token 前拒绝等模式。
- [机会路由测试](../../../tests/server/opportunities.test.ts)：参数、公式和假设费率行为。
- [Boros collateral 测试](../../../tests/server/boros-collateral.test.ts)：缺字段、子账户、分页与畸形账户。

后续脚本测试使用合成 envelopes、固定时钟及请求 stub；覆盖 UNKNOWN、身份切换、部分数据、资金不足、永续不能重复复用、缺换仓成本、零候选与不足五个候选。不得保存真实账户 fixtures。

## 核查限制

结构图项目为 `home-jerel-workspace-GitHub-arbitrage-with-crossex`，核查开始时 generation 为 `2026-10-07T11:02:38Z`。引用代码完成 coverage 核查且无记录缺口；此为 best-effort 信号，结论同时依据定位后的源码读取。代码后续变化时须复查。
