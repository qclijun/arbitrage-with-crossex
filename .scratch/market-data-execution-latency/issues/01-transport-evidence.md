# CrossEx 连接复用能改善哪些等待，且会引入哪些风险

Type: research
Labels: wayfinder:research
Status: ready-for-agent
Progress: resolved
Assignee: transport_research
Parent: [降低盘口与执行延迟风险决策地图](../map.md)
Blocked by: none
Research branch: research/latency-transport

## Question

当前 SDK、代理和连接配置为何使只读查询可由约 844ms 改善到 133ms？证据能外推到哪些操作、不能外推到哪些操作；首期设计必须保留哪些超时、认证、未知结果、资源释放与客户端热切换约束？

核对实际安装依赖与官方源代码，区分同请求重试、连接失败和订单结果未知；界定全客户端替换与局部修改的影响范围。提出需要由用户决定的边界，不替用户批准修改。

## Evidence entry points

- [本机诊断](../../four-leg-maker-requote/book-latency-2026-10-16.md)：短时只读对照及其局限。
- `src/core/clients.ts`、`src/core/estimate/books.ts`、`src/engine/venueGate.ts`；临时探针 `/tmp/requote-order-transport-probe.mts` 与同名 JSON。
- findings 写入本工单所属努力目录的 `research/transport.md`。研究分支单独提交文档，结果不修改产品代码。

## Completion evidence

一份可追溯到安装依赖、官方来源和现有样本的研究；明确外推边界、失败情景、后续决策。只读测速可选，不运行 live tests，不调交易写接口。

## Answer

2026-10-16：研究完成，见[CrossEx 连接复用的作用边界与风险](../research/transport.md)。当前安装代理实现每请求新建/结束销毁连接，显式池化的只读收益有源码和小样本支持；真实写请求收益仍 UNKNOWN。SDK 共享传输的范围、UNKNOWN/不重试写、池竞争和认证热切换/释放约束已列明，生产范围留给后续人工取舍。

研究分支 `research/latency-transport`，文档提交 `93bbe13`。只读研究，无产品或生产变更；主树保存该研究快照。
