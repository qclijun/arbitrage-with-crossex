# 02: Lighter BTC/ETH 结算历史，让 Lighter 配对在全部窗口参与排名

Type: task
Status: ready-for-agent
Blocked by: None (can start immediately)

**What to build:** 用户在 Directed pair rankings 中看到 Lighter 原生 BTC/ETH（USDC 永续，index 口径）与其他场所的方向组合，在全部五个窗口内按官方每小时已结算历史获得排名，并保留"费率差估算"标识。

前提：Gate/Lighter 当前费率接入已落地。当前费率按每小时结算、等于接口返回的 8 小时等效值 ÷ 8。2026-11-01 实测：Lighter 公共 fundings 接口按 market_id 和 1h 分辨率返回 `{timestamp: 秒, value, rate: "0.0012", direction: "long"}`，400 天前的数据也能读到。`rate` 看起来是不带符号的百分比（0.0012% = 1.2e-5，与交易页上的 1HR FUNDING 一致），正负号似乎由 `direction` 决定，需要核实。

- [ ] 先按官方文档并对照实盘结算记录核实：`rate` 的单位、`direction` 到正负号的映射、记录是否为已结算的最终值；任一项无法证明就停下来报告，不接入。
- [ ] 存储的历史费率与当前费率口径一致（每小时、每期比例），历史和当前的年化可以直接比较。
- [ ] Lighter 腿的历史可分页读取，缺期、重复、市场不匹配、分页停滞都会明确报错；按 market_id 读取时，要确认它映射到的是已证明的 perp 合约，而不是同名的 spot 市场。
- [ ] Lighter 配对在全部五个窗口可排名、可通过正收益过滤；跨口径组合仍标为费率差估算。
- [ ] 只对 BTC/ETH、按每小时结算节奏读取，不超出公共接口限额；一年历史的回填有边界、可恢复；重启后从已保存的历史恢复。
- [ ] 离线回归覆盖符号映射、单位换算、正/零/负费率和局部历史失败；`yarn verify` 和生产构建通过。

## Comments

- 2026-11-01：由 Gate/Lighter 当前费率接入的后续拆出；与 01 互不阻塞。
