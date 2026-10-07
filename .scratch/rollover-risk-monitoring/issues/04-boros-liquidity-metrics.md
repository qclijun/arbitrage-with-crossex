# 04: Boros Spread 与双边订单簿深度计算

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第一阶段：市场流动性
Blocked by: 03

## Problem

以公开 market 快照计算可比较的流动性指标；此阶段不依赖账户持仓、具体展期计划或完整批次模拟。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [ ] 输出最佳 bid/ask APR、mid APR 和 Spread；采用 02 核验的 APR 方向定义公式，内部统一 APR fraction，页面用百分点（pp）或 APR bp（1 bp = 0.01 pp），不套用现货价差百分比。异常交叉盘口标记异常，不取绝对值掩盖问题。
- [ ] 逐侧输出可见累计深度、档位数与最远 APR；注明这是已返回范围的可见深度，截断/分页不全不能声称全书总量。
- [ ] 逐侧给出距各自最佳档位 10/25/50 APR bp 内的累计深度，明确端点包含、窗口定义和数量单位；这些是诊断窗口，不是交易滑点设置或协议边界。
- [ ] 在官方换算可验证时同时展示 YU 与抵押资产数量，否则保留原生单位及 UNKNOWN 换算；不同 collateral/到期/venue 不直接相加。USD 转换仅在价格与时间可信时输出。
- [ ] 完整零挂单的一侧可见深度为 0，其 best APR、mid/Spread 在不可计算时 UNKNOWN；缺失侧深度 UNKNOWN，不能补 0。负量/无效 APR/重复档位与不完整数据按契约处理。
- [ ] 离线边界测试验证 APR 单位、方向、排序、档位累计、窗口端点、空/单边/交叉/截断盘口及量纲换算；市场成交量与 OI 直接使用已核验口径，不能由深度推算。

## Out of Scope

账户展期计划、四腿就绪/保证金结论、历史成交量与订单簿持久采集、自动展期及交易操作。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。
