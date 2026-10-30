# 五源公开历史接口限流与预算实测补验

Type: task
Status: resolved
Assignee: Codex
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
- [23公开校准与剩余UNKNOWN](../evidence/23-public-calibration.md)
- [23逐请求参数/响应头/正文哈希与原始归档](../evidence/23-public-samples-20261030/manifest.json)
- [23双轴复审](../evidence/23-review.md) / [实施交接与验证](../evidence/23-implementation-handoff.md)
- [用户授权JA后的Binance/Bybit成功补验及实际连接证明](../evidence/23-ja-verification.md)
- [五源官方规则与CCXT能力边界](../evidence/23-documented-rate-limits.md) / [文档对照及冷却修正](../evidence/23-documented-calibration.md)
- [最终双轴复审](../evidence/23-completion-review.md) / [完成交接](../evidence/23-completion-handoff.md)

## Comments

- 2026-10-30：用户明确“签收工单23，继续实现下一个工单”。接受本票已记录的公开证据、官方/CCXT规则、冷却修复与UNKNOWN边界；不授权部署、开仓或实盘交易。

- 2026-10-30：根据用户选择从22拆出；22按UNKNOWN签收实现，本票open、未认领。人工开仓仍关闭。
- 2026-10-30：开始只读补验；独立串行探针使用现有出口，不主动触发限流、不自动重试；缺失证据继续UNKNOWN，完成取证不等于全部验收。

## Answer（首次补验部分交付，未 resolved）

2026-10-30完成9次低频公开采样并归档正文、请求参数、响应头、耗时和SHA-256：Aster/OKX/HL返回200；Binance仍451（地区资格拒绝）、Bybit仍403（CloudFront国家阻断）。Aster产品分钟权重1/2400可核验，历史缺头保持UNKNOWN；HL24/500条对应文档保守估算22/45，非实测扣账。五场所逐项结论、官方规则、实际collector配置及离线/实测分层见23证据。

剩余验收：Binance/Bybit可用历史与头、真实Retry-After秒/日期、429/418与业务限流、Bybit剩余/重置、MBX高水位、HL扣账/恢复及共享IP负载均未证实，继续UNKNOWN。补齐需合规可访问的已授权公开样本/访问条件，以及自然限流记录或场所认可的隔离条件；不自行换出口、不耗尽额度。本次不再次拆票或默认按UNKNOWN签收，23保持claimed，21依赖保留，人工开仓仍关闭。

## JA授权补验（阶段记录）

2026-10-30用户明确授权使用Clash Verge的JA分组验证。通过既有7899专用listener，6次公开请求全部HTTP200：Binance历史1条及产品分钟权重151/2400；Bybit历史1条/200条及retCode=0。另两次请求按TCP源端口匹配本次新连接，实际chains包含JA。原451/403保留为首次出口结果，当前JA出口的公开历史访问缺口已补，不再以其阻塞当前访问。请求参数、响应头、正文哈希及连接证据见JA补验；未修改Clash、JA节点、.env或生产服务。

仍未观测真实Retry-After、429/418、业务限流、Bybitremaining/reset、MBX高水位冷却、HL扣账/恢复和共享IP负载；Binance产品分钟权重不证明资金费500/5min剩余次数。以上继续UNKNOWN，23保持claimed、21依赖保留、开仓关闭，不因本次HTTP200自动宣称完整容量或签收。

## 官方文档 / CCXT补验

用户补充要求从官方或CCXT文档获取规则后，已完成五源一手规范与CCXT Manual核对。文档已确定静态配额/计数维度/已公布封禁范围；不能由文档得到的实时余量、未承诺响应头与真实恢复样本继续UNKNOWN。已修正Bybit特定403至少10min、Binance/Aster未知期限418按3d上界保守阻断、未来ban截止与提示优先、Binance无恢复提示的429/-1003按5min兜底；均有离线回归，完整门禁和双轴复审通过。原Scope允许未观察行为保留UNKNOWN，不要求主动诱发全部限流；此前更严的结单前提不再沿用。

## Answer（最终：resolved，保留能力限制）

2026-10-30按原Acceptance完成：五源初次9份公开响应及JA后续6份响应均有参数/头/耗时/哈希和原始归档，JA新连接可归属本轮；五源官方及CCXT规则引用齐全，规范、保守策略与实测分开；实现提交a91f2c6补足冷却保护，定向37项、默认完整verify（后端3625通过/8跳过，前端1788通过）及Web构建退出0；双轴复审0缺陷。

历史claimed记录描述当时阶段，由本结论覆盖。真实限流/冷却/扣账、未返回remaining/reset、共享IP及其他进程负载、reader跨实例/重启的冷却状态继续明确保留在21，未当作PASS；没有为获取样本主动耗尽IP。23交付不证明完整来源能力、历史周期/上市或交易准入，不改变生产代理、不启用开仓。
