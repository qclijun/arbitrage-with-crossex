# 02: Lighter BTC/ETH 结算历史，让 Lighter 配对在全部窗口参与排名

Type: task
Status: resolved
Blocked by: None (can start immediately)

**What to build:** 用户在 Directed pair rankings 中看到 Lighter 原生 BTC/ETH（USDC 永续，index 口径）与其他场所的方向组合，在全部五个窗口内按官方每小时已结算历史获得排名，并保留"费率差估算"标识。

前提：Gate/Lighter 当前费率接入已落地。当前费率按每小时结算、等于接口返回的 8 小时等效值 ÷ 8。2026-11-01 实测：Lighter 公共 fundings 接口按 market_id 和 1h 分辨率返回 `{timestamp: 秒, value, rate: "0.0012", direction: "long"}`，400 天前的数据也能读到。`rate` 看起来是不带符号的百分比（0.0012% = 1.2e-5，与交易页上的 1HR FUNDING 一致），正负号似乎由 `direction` 决定，需要核实。

- [x] 先按官方文档并对照实盘结算记录核实：`rate` 的单位、`direction` 到正负号的映射、记录是否为已结算的最终值；任一项无法证明就停下来报告，不接入。
- [x] 存储的历史费率与当前费率口径一致（每小时、每期比例），历史和当前的年化可以直接比较。
- [x] Lighter 腿的历史可分页读取，缺期、重复、市场不匹配、分页停滞都会明确报错；按 market_id 读取时，要确认它映射到的是已证明的 perp 合约，而不是同名的 spot 市场。
- [x] Lighter 配对在全部五个窗口可排名、可通过正收益过滤；跨口径组合仍标为费率差估算。
- [x] 只对 BTC/ETH、按每小时结算节奏读取，不超出公共接口限额；一年历史的回填有边界、可恢复；重启后从已保存的历史恢复。
- [x] 离线回归覆盖符号映射、单位换算、正/零/负费率和局部历史失败；`yarn verify` 和生产构建通过。

## Comments

- 2026-11-01：由 Gate/Lighter 当前费率接入的后续拆出；与 01 互不阻塞。
- 2026-11-02：Claude 认领。

## Answer

Lighter BTC/ETH 已按官方每小时已结算历史接入，五个窗口都能排名。Lighter 与其他场所的组合（index 口径对 mark/oracle 口径）全部标为费率差估算。

- 证据见 [evidence/lighter-settled-history.md](../evidence/lighter-settled-history.md)：
  - `rate` 是不带符号的每小时百分比，`direction: short` 为负。
  - 记录是已结算的最终值：公共资金池 LLP 30 天的 1438 条资金费流水与 `/fundings` 逐条一致，带符号费率和实付金额都相同，覆盖 208 条负费率、47 条零费率。
  - 入库口径为每小时比例，与当前费率（8 小时等效值 ÷ 8）一致。
- 实现：`src/core/funding/lighter-history.ts`。
  - 每小时读一次 `orderBooks`，要求恰好一本同名 perp 订单簿，同名 spot 市场不会被选中。
  - 请求起点提前两小时，并从本页最旧一行往回翻页，以应对接口"丢掉最旧一条匹配行"的行为。
  - 重复、倒序、非整点、超出范围、市场不符、不应出现的空页都会报错。
  - collector 原来只给 HL 用的分段续读改成来源上的 `staged` 标记，Lighter 也用它：每次结算先读最近一页，再续读其余部分，有预算上限，重启后可续。
  - 本地配额 30 次/分钟（官方为每 IP 60 次/分钟），历史请求间隔 3 秒。
- 已知代价：证据不跨截止时间拼接（与 HL 相同），所以每小时要重读一年，BTC 和 ETH 合计 25 次请求，在每轮预算之内。
- 回归：`tests/unit/funding-lighter-history.test.ts`、`tests/unit/funding-lighter-ranking.test.ts`、`tests/server/funding-lighter-restore.test.ts`。
