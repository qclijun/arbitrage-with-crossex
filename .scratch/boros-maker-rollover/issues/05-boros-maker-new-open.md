# 05: 新开仓使用一条 Maker 腿 + 补齐腿

Type: task
Status: ready-for-agent
Blocked by: 04
Parent: [Boros Maker 决策地图](../map.md)

**What to build:** 新开 Boros 资金费仓位时，可选让一条腿挂单、另一条腿按成交量吃单补齐，Boros 完成后再走现有永续 `best` maker+hedge。决定见票 03 的 Q5–Q15，依据见 [ADR 0003](../../../docs/adr/0003-boros-single-maker-leg-with-completion.md)。

- [ ] Maker 腿取目标规模下买卖价差较大的一侧，deal 创建时持久化。新开 Spread 只有一张单，没有补齐腿。
- [ ] 启用门槛：一条腿预计省费 ≥ $0.5（可配置），不满足就整单吃单。
- [ ] 每确认一笔 Maker 成交且累计满 Boros 最小下单额，立即吃单补齐，容差 0.25 个百分点；失败时放宽到 0.5 再试一次，仍失败就告警并隔离。
- [ ] 补齐腿可成交利率比创建时变差超过 5bp（可配置），撤掉挂单，剩余转吃单。
- [ ] 最多等 30 分钟（可配置）。超时撤单，拿到撤净确认后剩余数量走现有双腿吃单路径。
- [ ] deal 结束时不足最小下单额的尾差，记为过覆盖尾差并展示。
- [ ] 永续腿在 Boros 完成或回退完成后才建立。
- [ ] 回执分开展示 Maker 成交价相对中间价的改善，以及实际省下的手续费，供事后统计。
- [ ] 离线测试覆盖上述分支；`yarn verify` 与 `yarn --cwd web build` 通过。
