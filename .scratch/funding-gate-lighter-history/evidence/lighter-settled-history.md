# Lighter 历史资金费：单位、符号与已结算终态证据（工单 02）

取证日期：2026-11-02（UTC）。对象：Lighter 永续 BTC（market_id 1）、ETH（market_id 0），接口 `GET https://mainnet.zklighter.elliot.ai/api/v1/fundings?resolution=1h`。只用公共接口。用来对照的“实盘结算记录”是公共资金池 LLP（account_index 281474976710654）的逐笔资金费流水。按官方文档，公共资金池的流水不需要授权，所以没有读取任何个人账户或凭据。

## 结论

**三项都已证明**：
- **单位**：`rate` 是不带符号的每小时百分比。
- **符号**：`direction: long` 为正（多头付费），`short` 为负（空头付费）。
- **已结算**：每条记录都是已结算的最终值。

入库口径为带符号的每小时比例，与当前费率（feed 的 8 小时等效值 ÷ 8）单位一致，两者的年化可以直接比较。

### 1. 官方文档

- [fundings](https://apidocs.lighter.xyz/reference/fundings)：字段为 `timestamp, value, rate, direction`，每次最多 750 条。文档**没有**写单位、符号，也没有说是否已结算，所以下面三项都来自实盘对照。
- [Funding](https://docs.lighter.xyz/trading/funding)：
  - 每个整点结算（“Funding payments occur at each hour mark”）。
  - 正费率时多头向空头付费。
  - 资金费 = −仓位 × index 价格 × 费率。
- [positionFunding](https://apidocs.lighter.xyz/reference/positionfunding)：账户逐笔资金费流水，字段为 `change, rate, position_size, position_side`；查询公共资金池时可以不带授权。

### 2. 单位

- `value` 等于 index 价格 × `rate`/100。例：BTC 00:00Z 一条 `rate "0.0012"`、`value 0.9400944`，换算出的 index 约 78,341；ETH `0.0012` 对应 `0.02730252`，约 2,275。两者与当时价格相符。
- 同一时刻 `funding-rates` 给出的 BTC 8 小时等效值为 9.6e-5，÷8 = 1.2e-5 = 0.0012 %。

### 3. 符号与已结算：逐笔对照 LLP 流水（`lighter-ledger-30d-20261102.json`，脚本 `lighter-ledger-check.py`）

- 读取范围：2026-10-03 00:00Z 至 2026-11-02 00:00Z 的 LLP BTC/ETH 流水，共 17 页，1442 条。每一页请求和响应的 SHA-256 都已保存。
- **1438 条与 `/fundings` 同一小时的记录逐条一致**：
  - 流水的 `rate`（带符号的比例）= `rate`/100 × (long ? +1 : −1)，0 处不符。
  - `change` = −side × `position_size` × `value` × (long ? +1 : −1)，0 处不符（容差 1e-6 相对值）。
  - 覆盖 1230 条 long、208 条 short（负费率）、47 条零费率。
- 另外 4 条落在窗口两端，属于下面第 4 节的端点问题，不是数据缺失。
- 实际资金费按这些值逐笔记账，所以它们是已结算的最终值。`rate` 只有 4 位百分比小数，即比例的 1e-6 精度；流水的 `rate` 精度相同，结算用的就是这个精度。

## 4. 接口语义（实测，`lighter-history.ts` 依赖这些行为）

- 行按时间从旧到新排列，`timestamp` 是整点秒，没有处理延迟，与流水时间一致。行里没有市场字段。
- 匹配规则是 `start ≤ t < end`。结果最多保留最新的 750 条。若 `end` 没有越过最新一条结算，还会**丢掉最旧的一条匹配行**。例：`(T−2H, T+1)` 返回 `[T−H, T]`，`(T−2H, T)` 只返回 `[T−H]`；`(T−800H, T−10H)` 返回 749 条，从 `T−759H` 开始。
- 实现的应对：
  - 每次请求的起点提前两小时，被丢掉的只会是窗口外的行。
  - 下一页的 `end` 取本页最旧一行（不含端点），被丢的那一行会出现在下一页。
  - 本页最旧一行到达窗口起点时结束。空页只有紧挨上线时间时才算结束（上线首小时那一行是唯一会被单独丢掉的匹配行）；否则报错 `history-page-empty`。
  - 重复、倒序、非整点、超出请求范围的行都会报错；行里若带有不同的 `market_id`/`market`，报错 `history-contract-mismatch`。
- `count_back` 实测不起作用（取 3 时仍返回窗口内全部行），统一传 0。
- 起点等于或晚于终点时返回 `code 22400`。毫秒时间戳也会被接受，所以实现只用秒，归一化时拒绝毫秒。
- 400 天前的数据仍然可读：BTC 2025-01-17 08:00Z 上线起就有记录，比 catalog 的 `created_at`（07:21Z）晚。
- `market_id` 映射：spot 市场返回 `code 21619 invalid market type`，不存在的 id 返回 `21602`。实现每小时读一次 `orderBooks`（错误响应不缓存，下次重读），要求恰好一本 `market_type: perp` 且 `symbol` 等于合约 ID 的订单簿，否则报错 `history-market-unmapped`；同名的 spot 市场 `ETH/USDC` 不会被选中。映射请求的哈希会写进每一页的 `rawHash`。
- 限流：[官方](https://docs.lighter.xyz/developers/reference/rate-limits.md)（原 apidocs.lighter.xyz/docs/rate-limits，现 301 跳转）规定标准 IP 每滚动分钟 60 次，按端点合计。本地读取器的 Lighter 配额为 30 次/分钟，与 catalog 的 `orderBooks` 读取共用；历史请求间隔 3 秒，最多占 20 次，给 catalog 留出余量。
- 读取量：每个整点每条腿重读一年，即 1 次映射 + 12 页（最近一页优先）。BTC 和 ETH 合计每小时 25 次，不超过每轮 40 次的预算。不同截止时间的证据不拼接，这与 HL 相同。

## 仍为 UNKNOWN

- 官方没有文字承诺历史行永不修订。evaluator 对同一时刻的不同值按冲突隔离。
- 上线首小时的记录在“丢最旧一行”规则下可能读不到。BTC/ETH 上线在 365 天窗口之前，不受影响。
