# Maker 展期可行路径与采用门槛决策

Type: grilling
Label: wayfinder:grilling
Status: claimed
Claimed by: root
Blocked by: 01, 02
Parent: [Boros Maker 展期优化决策地图](../map.md)

Dependencies: [Boros Maker 展期能力与原子性核验](01-maker-atomic-capability.md)；[Boros Maker 展期净节省与成本口径核验](02-maker-net-savings.md)

## Question

在能力和净节省证据齐备后，是否采用 Maker 展期，采用哪一条满足既定风险边界的路径，以及哪些收益、等待和异常条件决定等待、撤单或原子 Taker 回退？

## Scope

- 先判断可行性和收益规模；允许结论为保留原子 Taker，不为使用 Maker 而扩大风险。
- 用双方认可的净节省门槛与风险数值边界作决策；未知输入不得默认为零或可接受。
- 将部分成交、取消中的新增成交、unknown、到期逼近、报价变化、重启恢复等具体场景带回人工讨论。
- 此票只锁定路径与采用门槛。只有研究使细节明确后，才为状态设计、原型或验收规格新增决策票，避免提前实现。
- 必须由用户参与；代理不能替用户选择可承受的损失或等待时间。

## Completion

记录已确认选择、被排除路径、适用边界和仍需新增的决策票；在研究未解决时不认领或预先作答。

## Comments

2026-10-22：用户提出“一笔 Maker 加一笔 Taker”候选，正在讨论，尚未确认采用。若旧/新各为一个原生 Spread，则展期是两个 Boros 订单；不包含 Gate 永续。Maker 先成交、再按已成交量提交 Taker 会失去平旧开新的原子性：先平旧产生资金费覆盖缺口，先开新产生临时过覆盖。两者均需按已确认边界检查数量和持续时间，且考虑 Taker 失败或 unknown；未指定风险限额、等待时限或收益门槛，不可自行补齐。

2026-10-22：讨论一小时资金费覆盖空档，方法见[合成敏感度](../evidence/hour-gap-estimate.md)。公开版不包含私人持仓与收益。敏感度不是固定损失或上限，亦未覆盖重新入场锁息影响剩余期限的损益；不据此设风险阈值或授权执行。
