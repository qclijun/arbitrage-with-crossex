# 09: Risk 状态、新鲜度、经济性与到期语义整合

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第二阶段：原子展期风险
Blocked by: 08

## Problem

将计划、四腿深度和批次模拟转换为 Risk 指标与规则，保留原票的全部既有语义。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [ ] 技术就绪 executable/blocked/UNKNOWN 与经济性、到期严重度分别表达；已知阻断与未知证据同时可见，保留所有来源时间/完整性/原因。
- [ ] 按完整规格保留盘口与模拟 12 秒边界、14 天/1 天严重度及 PAUSED；只有完整远期持仓证据允许暂停，资金费缺口仍可见，慢刷新只给指示结果。
- [ ] 经济性使用同规模/同期限实际执行 APR、旧腿退出 PnL 和成本；保留既有 APR 量纲，不以经济性差推断技术不可执行。
- [ ] 区分模拟通过、实际展期切换完成和结算完成；保留资金费缺口/过覆盖及未知实际结果，不从模拟或 rolledSize=0 伪造执行结果。
- [ ] 新指标或显式替代指标不偷换旧语义，catalog/规则/UI/Python 保持一致；不恢复隐藏历史检查，不改通知去抖。完成相应离线边界验收。

## Out of Scope

改变交易执行流程、自动展期、新采集系统、未列出的其他风险类别。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。
