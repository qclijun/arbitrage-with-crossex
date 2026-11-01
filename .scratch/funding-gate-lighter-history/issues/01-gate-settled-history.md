# 01: Gate BTC/ETH 结算历史，让 Gate 配对在 ≤180 天窗口参与排名

Type: task
Status: resolved
Blocked by: None (can start immediately)

**What to build:** 用户在 Directed pair rankings 中看到 Gate 原生 BTC/ETH（USDT 永续）与其他场所的方向组合，在 7–180 天窗口内按官方已结算历史获得排名，而不是显示 history-leg-missing。365 天窗口明确显示为不支持，而非数据缺失。

前提：Gate/Lighter 当前费率接入（BTC/ETH 合约映射、经济标的证明、mark 口径）已落地。2026-11-01 实测：Gate 公共历史接口按合约返回 `{t: 秒, r: 费率}`，8 小时一条；`from` 超过 180 天即报错，`limit` 上限 1000。

- [x] 先证明该历史接口返回的是已结算的最终费率（不是预测值或当前值），证据级别与其余五家相同、可审；证明不成立就停下来报告，不接入。
- [x] Gate 腿的历史可分页读取，缺期、重复、合约不匹配、分页停滞都会明确报错，不会静默接受；Gate 按合约变化的结算周期由已结算时间戳推算，不把今天的周期回填到过去。
- [x] 7–180 天窗口的 Gate 配对可排名、可通过正收益过滤；365 天窗口给出"不支持"原因；未知值不当作零。
- [x] 只对 BTC/ETH、临近结算时读取，不超出 Gate 公共接口限额；重启后从已保存的历史恢复。
- [x] 离线回归覆盖正/零/负费率、局部历史失败和 365 天不支持，并覆盖与 HL（费率差估算）、与 CEX（同口径）的配对；`yarn verify` 和生产构建通过。

## Comments

- 2026-11-01：由 Gate/Lighter 当前费率接入的后续拆出；与 02 互不阻塞。
- 2026-11-01：Claude 认领并实现。

## Answer

Gate BTC/ETH 已按官方已结算历史接入，7–180 天窗口可排名，365 天显示"不支持"（`historical-source-unsupported`）。

- 已结算证明见 [evidence/gate-settled-history.md](../evidence/gate-settled-history.md)：官方文档把历史端点与当前费率分开，并规定结算按区间内最后一次计算的费率。生产对照显示：历史不含进行中的一期；16:00Z 结算时 BTC 结算前最后一次采样与历史新行完全一致，ETH 相差 1e-6，按每分钟重算可以解释；跨过一次结算后 539 行/合约重读不变。账户 funding fee 流水对照没有做（需要凭据）。
- 实现：`src/core/funding/gate-history.ts`（按秒、从新到旧、`to` 不含端点分页；重复（含跨页同一小时）、顺序错、超出请求范围、合约不符、分页停滞都会报错；180 天段 `from` 留在 Gate 限额内）。`history-sources.ts` 把 Gate 列为 verified，>180 天为 unsupported。`settlement-time.ts` 把 60 s 内的处理延迟映射到结算整点。周期由 refresher 从已结算时间推算。读取器配额为 100 次/10 秒。
- 回归：`tests/unit/funding-gate-history.test.ts`、`tests/unit/funding-gate-ranking.test.ts`、`tests/server/funding-gate-restore.test.ts`。
- 给 03：只传 `to` 时 REST 能读到约 205 天前的数据，可能不必依赖归档。
