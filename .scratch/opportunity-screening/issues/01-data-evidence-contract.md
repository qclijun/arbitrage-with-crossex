# 哪些终端证据足以支持一次机会筛选

Parent: ../map.md
Label: wayfinder:grilling
Type: grilling
Mode: HITL
Status: resolved
Triage: ready-for-agent
Progress: resolved
Assignee: root
Blocked by: none

## Question

首版只复用现有本机只读接口。怎样核对账户与钱包范围、时间戳、缓存陈旧性、完整持仓和实际手续费来源，使“能够计算候选收益”与“证据不足”有明确边界？现有接口缺字段时怎样按用户要求降级 UNKNOWN？

需要回答的具体分支：

- 读取接口白名单、本机认证来源、限制跳转及请求超时；不得读取或输出交易私钥。
- `ts`、`observedAt`、`asOfSec`、数据内 `stale` 和 envelope `stale` 分别证明什么；年龄和跨接口时间偏差如何配置。
- 扫描开始及结束账户身份改变、钱包不匹配、无完整持仓或请求失败时，哪些结果可以保留、哪些必须 UNKNOWN。
- Opportunity 实际账户手续费与 VIP0 降级、逐市场返费适用性、盘口可用性及部分结果的证据规则。
- 能否安全复用现有 Python 请求工具；Python 与 TypeScript 的选型根据依赖和共享计算的事实决定。
- 列出首版不能证明的事项与相应 UNKNOWN 原因，不修改终端 API。

## Comments

- 2026-10-07：用户要求依据原则文档编写脚本，默认只读；账户点时数据不得写入工单或提交为实盘测试 fixture。
- 2026-10-07 用户确认：首版仅脚本，缺证据标 UNKNOWN；终端 API 补充另列后续工单。
- 图核查：`buildOpportunities` 位于 `src/core/boros/opportunities.ts:839`，由 `src/server/routes/opportunities.ts` 调用。机会接口返回收益模型结果，脚本无需重新实现交易所报价。
- 本地 explorer 已完成只读核查，报告为 [现有终端数据与脚本复用边界](../evidence/source-review.md)。此票尚未认领、解决或实现。

- 2026-10-08：按用户要求更新状态。原始问题与初始 needs-info 分诊保留为历史；完成判定以最终确认的“仅筛选 Opportunity”范围为准。

## Answer

- 当前范围的数据契约已由[最终规格](../spec.md)、[实施票 04](04-readonly-opportunity-screening.md)和[使用说明](../../../docs/OPPORTUNITY-SCREENING.zh-CN.md)覆盖：仅本机 Opportunity GET，限制代理/跳转并保护认证信息，核查 close/roll 范围与报价口径，分别检查行情和静态新鲜度，缺费用或盘口证据保留 UNKNOWN。
- 账户、钱包、完整持仓及账户适用性已由用户移出范围，不宣称这些原始分支已实现或验证。后续用户明确批准分类新鲜度及盘口失败诊断 API 扩展，取代初始“不修改 API”的相关限制。
- 27 项合成脚本测试通过，覆盖传输安全、脱敏、费用证据、新鲜度、范围匹配及降级语义。本票无当前范围内的待决事项，关闭为 resolved，不表示重新进行了初始访谈。
