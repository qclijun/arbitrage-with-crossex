# Boros Maker 展期净节省与成本口径核验

Type: research
Label: wayfinder:research
Status: resolved
Claimed by: maker-economics-research
Blocked by: —
Parent: [Boros Maker 展期优化决策地图](../map.md)

Next decision: [Maker 展期可行路径与采用门槛决策](03-adoption-and-execution-policy.md)

## Question

相对于当前原子 Taker 展期，采用 Maker 真正可减少哪些费用，新增哪些成本，如何按每次展期和全年展期频次计算净节省与回本门槛？

## Scope

- 核验 Maker/Taker、剩余期限计费、settlement、首次入市与 Gas 的官方口径；区分普通市场、双普通腿组合与 Spread，避免名义金额重复计算。
- 分别计算旧仓退出和新仓进入的剩余期限；不能统一使用新仓期限或全年费率直接乘本金。
- 保留两条路径共同承担的结算成本，不将其计为 Maker 节省。账户优惠、返佣、实际 Gas、额外撤挂单次数缺失时标 UNKNOWN。
- 将改价造成的执行利差变化、等待期间利差损失与失败回退成本纳入比较式，不编造概率、未来利差或成交承诺。
- 给出透明公式与可复核示例；已有持仓快照不足以得出实际金额时列出缺失字段，而非填零。

## Evidence and completion

- 第一方资料逐项链接并记录日期。可使用 `/tmp/boros-held-market-fees-latest.json`（2026-10-22 20:24:46 台北快照，8/8 市场）、`/tmp/boros-fees-search.txt` 与 `/tmp/boros-fees-handoff-latest.md` 作为线索，费率须核对当前第一方契约；不得据此声称已核实账户实收。
- 单份研究文档保存于 `research/02-maker-net-savings.md`，包含每次展期公式、情景算例、回本条件、所需输入和 UNKNOWN。
- 不做账户写入、不预测实际长期 APR、不自行决定采用门槛。

## Answer

已完成[Maker 展期净节省公式与待补输入](../research/02-maker-net-savings.md)。Maker仅省对应Taker成交费；旧仓退出、新仓进入分别用各自剩余期限，双普通腿逐腿相加，单Spread不再乘2。完整净节省扣增量Gas、入市、结算、执行与等待损失及未重复计算的失败成本；所有缺失实收为UNKNOWN。10,000 USD每侧、旧7天/新30天的全Maker毛成交费节省情景为1.013699 USD，不能当成实际持仓节省。逐次/全年回本条件和缺失输入已列；不设采用门槛，不构成实施或交易授权。旧operation费搜索摘要对应页面已404，不能叠加当前费用口径。
