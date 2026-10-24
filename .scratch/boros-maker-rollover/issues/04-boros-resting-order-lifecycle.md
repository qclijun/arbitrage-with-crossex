# 04: Boros 挂单生命周期纳入 deal 引擎

Type: task
Status: ready-for-agent
Blocked by: 03
Parent: [Boros Maker 决策地图](../map.md)

**What to build:** 让 deal 引擎能持有一张 Boros post-only 挂单，覆盖它从下单到结束的整个生命周期：写前登记、下单、改价、撤单并拿到撤净确认、按成交增量推进，以及跨重启恢复。遵守单写者、每 tick 至多一次线上变更、unknown 先查证的约束。Boros 不提供交易所级 clientOrderId 去重，所以不能沿用面板的进程内 memo。依据见 [ADR 0003](../../../docs/adr/0003-boros-single-maker-leg-with-completion.md)。

- [ ] 挂单在线上提交前已持久化；下单结果为 unknown 时先查证，不重复下单。
- [ ] 只用 post-only（非 SOFT_ALO）。会立即成交而被拒时，计入独立预算，不与其他失败共用上限。
- [ ] 改价：落后 ≥2 tick 且距上次 ≥15 秒才改价，次数上限可配置（默认 5）。
- [ ] 撤净确认：挂单已不在订单簿，且撤单期间的新增成交已全部核清，才算撤单完成。只发出撤单请求不算完成。
- [ ] 成交增量以链上或接口事件为准，unknown 不降为零成交。
- [ ] 正常停机先撤单并拿到撤净确认再退出；异常退出后，重启先对账挂单状态和离线期间的成交。
- [ ] 离线测试覆盖：部分成交、撤单途中新增成交、unknown、重启恢复；`yarn verify` 通过。
