# 07: 展期使用 Maker 新仓腿 + 三腿原子补齐

Type: task
Status: ready-for-agent
Blocked by: 06
Parent: [Boros Maker 决策地图](../map.md)

**What to build:** 展期时只让一条新仓腿挂单。每确认一笔成交，把同等数量的另外三条腿（平两条旧腿、开另一条新腿）放进一个原子 FOK 批次补齐。决定见票 03 的 Q9、Q16、Q17，依据见 [ADR 0003](../../../docs/adr/0003-boros-single-maker-leg-with-completion.md)。

- [ ] 旧仓到期前 7 天开始挂单，到期前 ≤3 天停止；剩余部分走现有原子吃单展期。
- [ ] 补齐限 2 分钟内、最多 2 次；超出就停止挂单、告警、隔离，过覆盖部分交由人工处理。
- [ ] 过覆盖不超过一笔已确认成交量；资金费过覆盖与资金费缺口分开展示。
- [ ] Spread 展期：补齐腿就是旧 Spread 的平仓单。
- [ ] 风险页能看到进行中的 Maker 展期、当前过覆盖数量及持续时间。
- [ ] 离线测试覆盖：补齐被拒、部分成交、到期截止、重启恢复；`yarn verify` 与 `yarn --cwd web build` 通过。
