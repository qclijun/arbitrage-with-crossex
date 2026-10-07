# 06: 原子展期计划身份、候选市场与四腿权限

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第二阶段：原子展期风险
Blocked by: 05

## Problem

从已完成的市场流动性诊断进入具体账户原子展期计划，定义四笔实际操作与权限证据。遵循完整规格的 Scope and existing seams。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [ ] 按账户/子账户、collateral、旧新 market、venue、方向、到期、目标量和价格限制隔离计划及缓存。默认匹配完整持仓；不等量残余与部分展期剩余单独保留。
- [ ] 候选必须匹配标的/venue/方向/collateral 且到期更晚；完整市场覆盖下无候选为已知阻断，列表失败或部分覆盖为 UNKNOWN。
- [ ] 逐笔核验旧 A/B 平仓与新 A/B 开仓的官方模式/权限，区分 GOOD、OI Capped、Makers Only、Halted、到期与账户例外；未知不得默认为正常。
- [ ] 离线验收身份/候选/权限、账户切换和残余数量；市场成交量、OI 或有挂单不能证明权限。

## Out of Scope

改变交易执行流程、自动展期、新采集系统、未列出的其他风险类别。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。
