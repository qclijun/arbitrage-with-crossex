# 五源公开历史接口限流与预算实测补验

Type: task
Status: open
Assignee: none
Blocked by: 22

## Goal

接续22按UNKNOWN签收后仍未取得的公开校准证据，补齐官方历史接口的响应头、限流冷却及预算行为取证。来源为用户2026-10-30明确要求“公开校准另开跟进票”；22实现提交`67c1a83`，本票不重复实现历史计算或放宽未知能力。

## Scope

- 对Binance/Aster/OKX/Bybit/Hyperliquid分别记录可用的公开样本、出口可达状态、请求参数/数量/耗时、响应哈希及响应头。22时Binance451、Bybit403；访问受限仍为UNKNOWN，不当作无历史或无配额。
- 核对Retry-After秒数/HTTP日期、HTTP429/418及业务限流、Bybit remaining/reset、MBX分钟权重及官方同周期容量、HL基础和响应长度增权。缺失响应头不能当0，分钟权重不能当资金费500/5min计数器。
- 在可获得证据范围内校准内部配额、场所spacing、超时/重试及冷却是否保守；明确共享IP和其他进程负载的未知影响。未观察的真实限流行为继续UNKNOWN，不用离线fixture冒充实测。
- 只读探针与证据单列、不进入默认verify；不主动耗尽共享IP额度，不更改出口或生产服务，不查询账户、不执行交易、不启用开仓。需要额外访问条件时先陈述具体缺口，不能擅自改变运行环境。

## Acceptance

- 五场所逐项列明已验证、未知、访问受限与未观测行为，支持每项结论的公开来源和样本路径可追溯。
- 现有离线解析/冷却测试与公开样本分开；若修改实现，增加相应离线回归，默认完整verify及web build通过。
- 21引用本票真实证据及剩余限制；不得仅因22 resolved或单次HTTP成功宣称完整来源能力/可启用。仍不足的验收项必须显式保留或再次由用户决定处置，不能静默消失。

## Evidence

- [22公开样本及校准限制](../evidence/22-public-samples.md)
- [22实施交接](../evidence/22-implementation-handoff.md)
- [07来源研究及补充](../evidence/history-source-research.md)

## Comments

- 2026-10-30：根据用户选择从22拆出；22按UNKNOWN签收实现，本票open、未认领。人工开仓仍关闭。
