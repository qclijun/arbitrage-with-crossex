# 10: 原子展期 Risk 页面与全范围验收

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第二阶段：原子展期风险
Blocked by: 09

## Problem

接入既有 Risk 页面并完成原票所有验收条件，作为第二阶段完成关口。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [ ] 展示具体计划、四腿瓶颈、覆盖/缺口/残余、模拟证明数量与盘口估计、保证金、准备状态、证据时间及经济性；支持现有只读 inspect/requote。
- [ ] 完成完整规格 Testing Decisions 全部场景及 API → Risk conversion → 页面验收，涵盖账户/候选切换、失败恢复、PAUSED、已知阻断与 UNKNOWN 并存。
- [ ] 真实浏览器验证宽屏、375px、账户切换与缺失/过期状态并留存证据；运行相关离线检查与 web 生产构建，不运行真实下单测试。
- [ ] 证明页面刷新不触发交易、签名、授权、Gas 补充、后台监控或通知变更；逐项核对 01 原始验收清单，未满足项不得关闭父票。

## Out of Scope

改变交易执行流程、自动展期、新采集系统、未列出的其他风险类别。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。
