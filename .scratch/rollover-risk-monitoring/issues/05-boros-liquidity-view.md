# 05: Boros market 流动性指标展示与第一阶段验收

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第一阶段：市场流动性
Blocked by: 04

## Problem

在现有终端市场/风险页面的合适入口展示逐 market 的流动性快照，完成第一阶段闭环。复用现有页面与查询，不建设新的监控系统。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [ ] 逐 market 展示 venue、交易对、market ID、抵押资产、到期日、24h Volume、Notional OI、best bid/ask APR、Spread 与双边深度窗口；便于比较同标的不同到期市场，不合并其数据。
- [ ] 显示单位、窗口口径、源时间/采集时间、过期/不完整/UNKNOWN 原因；成交量/OI 与盘口可不同步。展示市场模式时只作元信息，未经后续权限核验不推断交易可用性。
- [ ] 使用截图的 venue 分组、Collateral/Maturity/24h Volume/Notional OI 作为信息组织参考；不要求像素复刻官网，不把截图数值当生产数据。
- [ ] 页面明确为市场流动性诊断，不输出原子展期 ready、保证可成交量或保证金结论；不新增流动性阈值告警、不更改通知/去抖。
- [ ] 完成离线 API → 指标 → 页面验收，涵盖正常/部分失败/空盘口/过期状态与 market 切换；完成真实浏览器宽屏及 375px 验收，确认无横向溢出并留存截图。只读官网/生产数据对照记录采集时刻与舍入差异，禁止真实下单测试。
- [ ] 验收 02–05 交付证据与第一阶段字段完整性；不可支持字段显式列出限制，不能用伪造值通过。第一阶段完成即停，后续按 06–10 单独推进。

## Out of Scope

账户展期计划、四腿就绪/保证金结论、历史成交量与订单簿持久采集、自动展期及交易操作。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。
