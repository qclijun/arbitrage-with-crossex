# 哪些时间证据能证明行情新鲜度和未对冲暴露改善

Type: research
Labels: wayfinder:research
Status: ready-for-agent
Progress: resolved
Assignee: freshness_research
Parent: [降低盘口与执行延迟风险决策地图](../map.md)
Blocked by: none
Research branch: research/latency-freshness

## Question

如何以交易所与本地独立时间证据度量行情年龄、报价在途和 Maker 成交后未对冲暴露，避免把请求 RTT、缓存年龄或订单观测延迟误作真正暴露时长？现有 tickPair 的哪些读取是紧急对冲必需、哪些只服务 Maker 追价？

核对 Gate/HL 官方时间字段及其语义、当前代码保留/丢弃的证据、时钟偏差与未知值表达、跨账户/合并持仓的归因。分析陈旧/无效/断线行情在新增获取和履行已有对冲义务中的不同风险；提出选择，不设定未经批准的硬阈值。

## Evidence entry points

- [本机诊断](../../four-leg-maker-requote/book-latency-2026-10-16.md)与[实盘验收](../../four-leg-maker-requote/live-validation-2026-10-16.md)。
- `src/core/estimate/books.ts`、`src/engine/venueGate.ts`、`src/engine/loop.ts`、`src/engine/decide.ts`。
- findings 写入 `research/freshness-and-exposure.md`，文档单独提交研究分支；不改产品、监控或持仓。

## Completion evidence

明确指标定义、可观察性缺口、纯函数与 IO 路径约束、可使用的离线故障情景；列出必须留给用户的风险取舍。WebSocket 仅核对未来数据契约，不设计首期接入。

## Answer

2026-10-16：研究完成，见[盘口新鲜度与未对冲暴露：研究证据](../research/freshness-and-exposure.md)。区分同机确认响应与跨 venue 实际成交暴露；源时间与缓存/RTT分开，跨钟误差未知。`project.unhedged` 扣除 B 预留，不代表真实暴露已消失。Maker bestA 读取可审查跳过，但不能连同 outage、取消优先、最小名义金额、dust、未知冻结和意图复核一起删掉。失效政策与阈值留给人工决策。

研究分支 `research/latency-freshness`，文档提交 `f6ee14e`。只读研究，无产品或生产变更；主树保存研究快照。
