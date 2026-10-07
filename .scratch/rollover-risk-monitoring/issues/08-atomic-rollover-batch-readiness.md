# 08: 完整展期模拟、批次保证金与执行准备证据

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第二阶段：原子展期风险
Blocked by: 07

## Problem

只读接入完整四笔足量批次模拟及执行准备元信息，验证平旧后开新的保证金语义。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [ ] 复用现有完整批次模拟；无完整/新鲜模拟或缺关键字段保持 UNKNOWN，四笔独立报价不构成通过。
- [ ] 展示 required margin、available after exit/roll、shortfall，使用真实 collateral 单位；缺值不补零，不复用 Open only 共存保证金。
- [ ] 区分目标量、已模拟通过数量、未确认最大量及残余；单次成功不证明最大容量，不新增自动最大规模优化。
- [ ] 只读展示账户兼容/授权有效期/执行服务准备/Gas 与自动补充可行性；不执行授权或充值，不曝光密钥，低 Gas 本身不等于必然阻断。
- [ ] 离线验证平旧释放保证金后通过、真实缺口、缺字段、错账户/过期授权、Gas 可补与不可补及失效模拟；证明无交易和状态修改副作用。

## Out of Scope

改变交易执行流程、自动展期、新采集系统、未列出的其他风险类别。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。
