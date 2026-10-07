# 03: Boros market 流动性快照只读获取

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第一阶段：市场流动性
Blocked by: 02

## Problem

按 02 核验后的契约接入逐 market 的公开统计与双边订单簿快照，为指标计算提供可追溯输入。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [ ] 复用已有 market 列表、统计、orderbook 适配器和缓存，返回 market 身份、24h Volume、Notional OI、双边档位及原始单位；首期范围为当前终端 market 列表可覆盖的 Boros markets，显式报告过滤条件与覆盖范围。
- [ ] 每个来源携带 source、sourceObservedAt（未知可空）、collectedAt、freshness、completeness、reason；统计与盘口各自计时，不伪装成同一时刻。源时间未知不能用接收时间冒充。
- [ ] 分页未完成、截断、单边失败、缺少字段、过期和请求失败逐字段保留 UNKNOWN 或部分覆盖；完整空盘口与数据不可用区分。保留旧快照时标明过期与失败。
- [ ] 缓存按 market 身份和查询范围隔离，复用当前刷新策略与限流；只读查询不触发模拟、签名、交易、授权、Gas 补充、后台监控或通知状态变化。
- [ ] 离线 API 验收涵盖多到期/多 venue、分页与部分失败、源时间缺失、过期和完整空盘口；证明 market 统计来源为市场全量而非账户 fills。

## Out of Scope

账户展期计划、四腿就绪/保证金结论、历史成交量与订单簿持久采集、自动展期及交易操作。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。
