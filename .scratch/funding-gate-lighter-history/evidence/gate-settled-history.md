# Gate 历史资金费：已结算终态证据（工单 01）

取证日期：2026-11-01（UTC）。范围：Gate USDT 永续 `BTC_USDT`、`ETH_USDT` 的公共接口 `GET https://api.gateio.ws/api/v4/futures/usdt/funding_rate`。只用公共市场数据，未读账户凭据、未下单。原始响应、哈希和脚本都在本目录。

## 结论

**verified（证据级别与其余五家相同，另有生产对照）。** 该接口逐条返回的是已结算期的最终费率，不是预测值或当前值。下面 1–2 是官方文档依据，与 07 对 Binance/Aster/HL 的认定方式相同（07 的认定依据：历史端点与当前/预测费率分开记录）。3–5 是 07 为 Gate 要求的“生产对照”。

1. **官方 API 文档**（[Futures market historical funding rate](https://www.gate.com/docs/developers/apiv4/en/futures)）：这是“historical funding rate”端点，字段为 `t`（Unix 秒）和 `r`。当前费率是另一个接口：合约接口 `GET /futures/usdt/contracts/{contract}` 的 `funding_rate`（另有已弃用的 `funding_rate_indicative`），与本端点分开。
2. **官方帮助页**（[Funding rate and funding fee](https://www.gate.com/help/futures/futures-logic/27569/funding-rate-and-funding-fee)）：
   - 费率每 60 秒计算一次，“The funding rate used for final settlement is the result from the last calculation within the current interval”；资金费按最终费率收取，不按预估值。
   - 默认 8h 结算（UTC 00/08/16），也有 4h 合约；费率触及上限时会自动改为 1h，且“will not be announced in advance”。所以周期必须从已结算时间推算，不能用今天的 `funding_interval` 回填过去（实现：`rules: []`，refresher 用 `inferFundingCadence` 推算）。
3. **不含进行中的一期**：14:37Z 读取时，历史最新一条是 08:00Z。合约接口显示 `funding_next_apply=16:00Z`，`funding_rate` 为 BTC 0.000075 / ETH 0.000021，与历史最新一条（BTC 0.0001 / ETH 0.000032）不同。
4. **结算前后对照**（`gate-settlement-20261101T1600Z.json`，脚本 `gate-settlement-capture.py`）：15:58–15:59:51Z 每 8 秒采样一次合约 `funding_rate`，16:00 结算后在 +94 s 和 +603 s 各读一次历史。
   - BTC：结算前最后一次采样（−11.7 s）为 0.000068，历史新行 `{t:1793548800, r:"0.000068"}`，**完全一致**。
   - ETH：结算前采样一直是 −0.000007（最后一次 −9.1 s），历史新行为 −0.000008，相差 1e-6。帮助页说最终费率是区间内最后一次（每分钟一次）计算的结果，最后 9 秒内的那次计算可以解释这 1e-6 的差，与“已结算最终值”的说法不矛盾。
   - 两行在 +94 s 和 +603 s 两次读取中相同，且都不同于结算后下一期的当前费率（BTC 0.000039 / ETH −0.000065）。
5. **不可变**（`gate-history-reread-20261101.json`，脚本 `gate-history-reread.py`）：跨过一次结算后重读，与 14:39Z 的 180 天读取（`gate-history-180d-20261101.json`）重叠的 539 行/合约**逐条相同**，没有修改、缺失或新增。

仍为 UNKNOWN：Gate 官方没有文字承诺历史行永不修订；evaluator 对同一结算时刻的不同值按冲突隔离处理。更强的对照是账户的 funding fee 流水（`account_book`），需要账户凭据，本次没有做。

## 接口语义（实测，`gate-history.ts` 依赖这些行为）

- 行为 `{r: string, t: number}`，没有合约字段，按时间从新到旧排列。`limit` 上限 1000，1001 返回 400 `INVALID_PARAM_VALUE`。传了 `from`/`to` 时，结果截断为区间内最新的 `limit` 条。
- `from` 包含、`to` 不包含：`from=to=t` 返回空；`from=t-8h, to=t` 只返回 t-8h 那一条；`to=t+1` 能返回 t 那一条。
- `from` 早于 Gate 时钟 −180 天约 10 秒以上时返回 400 `from time exceeds 180-day limit`（−10 s 可以，−60 s 被拒）。实现中 180 天段的 `from` 取 `max(start+60s, now−180d+60s)`：起点之后、下一个整点之前没有结算，所以不会漏期。若读取发生在整点前最后一分钟，这个下限会越过下一个整点，实现会明确报错而不是跳过。
- 只传 `to`（不传 `from`）时能读到约 205 天前的数据，留给工单 03 研究。
- `t` 是结算整点加处理延迟：180 天内 BTC 为 +0..3 s，ETH 为 +0..5 s，没有负偏移。实现接受 60 s 以内的延迟，并保留原始时间和映射依据；60 s 远小于最短 1h 周期。
- 合约不存在时返回 400 `CONTRACT_NOT_FOUND`。行里没有合约字段，所以“合约不匹配”只能通过三点保证：请求按合约发出；ID 必须是 catalog 已证明的 `BTC_USDT`/`ETH_USDT` 格式；如果 Gate 将来在行里返回 `contract` 字段，就逐条比对。
- 限流头：`x-gate-ratelimit-limit: 200`，约 10 秒重置。读取器按 100 次/10 秒配额。生产只读 BTC/ETH，到期才读：冷启动每腿 4 页，之后每次结算每腿 4 页。

## 180 天样本概况（`gate-history-180d-20261101.json`）

两个合约各 540 行，全部间隔 8h（±秒级延迟），无重复。BTC 有 3 次零费率、ETH 有 6 次，正负费率都有。
