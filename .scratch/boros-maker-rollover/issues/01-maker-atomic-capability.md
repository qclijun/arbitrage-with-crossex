# Boros Maker 展期能力与原子性核验

Type: research
Label: wayfinder:research
Status: resolved
Claimed by: maker-protocol-research
Blocked by: —
Parent: [Boros Maker 展期优化决策地图](../map.md)

Next decision: [Maker 展期可行路径与采用门槛决策](03-adoption-and-execution-policy.md)

## Question

Boros 的官方协议、API 或 SDK 是否支持能满足已确认资金费缺口与过覆盖边界的 Maker 展期路径？分别说明协议可能性、当前项目支持程度与尚无证据的部分。

## Scope

- passive Maker 的判定、post-only 或等价保护、限价单立即吃单的风险。
- old close 与 new open 是否能组成原子且被动成交的批次；普通双腿与 Spread 市场分开判断。原子提交与全量成交不能混同。
- resting order 的部分成交、撤单确认、撤单竞态、超时、链上/接口 unknown 的可观察状态与恢复依据。
- 当前四腿 FOK Taker 路径能否复用哪些能力；不能用当前未实现证明协议不支持，也不能用协议支持证明当前可直接使用。
- 记录不可行条件或反例；如必须串行裸露/重叠，明确与已确认边界的冲突，避免自行放宽边界。

## Evidence and completion

- 第一方资料逐项链接，记录访问日期和支持结论的位置。没有公开契约的项标 UNKNOWN。
- 单份研究文档保存于 `research/01-maker-atomic-capability.md`。当前代码发现见 [代码能力核验证据](../evidence/code-discovery.md)，它不替代协议来源。
- 回答可行路径/不支持路径/未知项和后续待人工决策项；不做实现与账户操作。

## Answer

2026-10-22：完成[协议能力研究](../research/01-maker-atomic-capability.md)。官方支持 ALO/post-only、多市场批量建单；当前项目只接 IOC/FOK，不能据当前缺实现推断协议缺能力。普通多腿未来可独立成交；原生 Spread 是同期限一仓，不自动绑定旧新到期日。未找到未来四腿联动 Maker rollover 契约，能力仍为 UNKNOWN；批量原子建单不能替代未来成交原子性。官方 requireSuccess 的预模拟/全回滚表述需按实际部署补证。当前撤净确认和跨重启 Maker 恢复亦未获证，详见报告。

研究票 resolved 仅表示证据整理完成，不代表 Maker 路径通过风险门槛。下一票结合费用证据及既有资金费缺口/过覆盖边界判断，未选择风险、等待或收益阈值；未执行交易或账户变更。
