# Boros Maker 展期优化决策地图

Label: wayfinder:map
Updated: 2026-10-24 Asia/Taipei

## Destination

为 Boros 新开仓与展期确定是否采用 Maker 的可实施方案与验收标准（2026-10-24 起范围由“仅展期”扩大为“开仓与展期”）。方案须说明实际净节省、风险边界、等待与撤单、异常恢复和原子 Taker 回退条件，使后续实施无需再猜关键决策。

## Notes

- 用户已确认目标、风险边界与三项决策拆分，先研究再决定方案。本阶段为规划，不实施或交易。
- 不引入超出现有容忍边界的资金费缺口或过覆盖。允许未成交订单等待与撤单；Maker 无法满足边界时保留当前原子 Taker 路径。边界的具体数值、证据与适用范围尚需核实，不能自行补成零或任意阈值。
- 原子性与全量成交分开判断；撤单请求发出与撤单确认分开判断；资金费缺口与永续价格净敞口分开判断。沿用 [领域词表](../../GLOSSARY.md)。
- 遵循 wayfinder、research、grilling、domain-modeling 和项目 [本地工单约定](../../docs/agents/issue-tracker.md)。结构查询遵循 codebase-memory。
- 研究只读，外部结论使用第一方资料。缺失证据标 UNKNOWN。用户授权建立本地地图；研究保存在本目录，不推送远端分支或发布 PR。
- 实施时仍须遵循引擎单写者、写前登记、unknown 探测和隔离等项目约束；本图不构成实施或实盘测试授权。
- 工作前认领；研究票可并行，人工决策每次会话最多解决一项。依赖关系记录于票正文，按编号查询开放、无阻塞、未认领的前沿。

## Decisions so far

- [Boros Maker 展期能力与原子性核验](issues/01-maker-atomic-capability.md)：协议支持 ALO；跨到期日多腿未来成交绑定仍 UNKNOWN，当前项目未接入 resting Maker，不据此批准实施。
- [Boros Maker 展期净节省与成本口径核验](issues/02-maker-net-savings.md)：已核费用机制、逐腿剩余期限与净节省比较式；实际持仓节省仍缺输入，不预设采用门槛。
- [Maker 展期可行路径与采用门槛决策](issues/03-adoption-and-execution-policy.md)：2026-10-24 用户确认 Q1–Q18。采用“一条 Maker 腿 + 补齐腿”，新开仓与展期均适用；展期只挂新仓腿、其余三腿原子 FOK 补齐。依据见 [ADR 0003](../../docs/adr/0003-boros-single-maker-leg-with-completion.md)。

## Not yet specified

- 实施工单 04–07 已列出，具体状态设计与验收以各票为准。
- 每笔 Boros 操作的实际 gas 只有按余额变化的粗估（$0.01–0.05），需在首次实盘验证中实测。
- 协议层面跨到期日的未来成交绑定仍为 UNKNOWN（票 01）。ADR 0003 的结构不依赖它：补齐由本地按已确认成交量发起。

## Out of scope

- 最终退出和其他平台的 Maker 优化（初次开仓已于 2026-10-24 纳入范围）。
- 为省手续费主动扩大资金费缺口或过覆盖。
- 修改交易代码、运行实盘测试、下单、转账、调整杠杆或账户配置。
- 预测长期实际年化，或将历史每日收入视为永久不变。
