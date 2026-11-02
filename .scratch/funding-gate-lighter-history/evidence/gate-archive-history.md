# Gate 365 天：官方月度归档（工单 03）

取证日期：2026-11-02（UTC）。对象：Gate USDT 永续 `BTC_USDT`、`ETH_USDT`。只用公共数据，没有读取任何凭据。

## 结论

**有可信的官方来源。** Gate 官方[历史数据下载页](https://www.gate.com/developer/historical_quotes)提供 `futures_usdt/funding_applies`，说明是 "Executed funding rate"（已执行的资金费率）。同页的 `funding_updates` 另称 "Update of forecasted funding rate for the next cycle"，与已执行费率分开。

归档与 REST `/futures/usdt/funding_rate` **逐条一致**（`gate-archive-vs-rest-20261102.json`，脚本 `gate-archive-compare.py`）：

- 范围：2025-09 至 2026-10 共 14 个月，BTC、ETH 各 1278 条。
- 两边的原始秒级时间完全相同，费率文本完全相同。
- 任何一边都没有多出的行。
- REST 一侧只传 `to`、按最旧一行往回翻页，共 15 页。每个文件和每页 REST 响应的 SHA-256 都已保存。

## 归档格式（实测）

- 地址：`https://download.gatedata.org/futures_usdt/funding_applies/{YYYYMM}/{合约}-{YYYYMM}.csv.gz`。每个合约每个 UTC 月一个文件。
- 文件是 gzip 压缩的 CSV，没有表头，每行 `秒级时间,费率`，按时间升序，每次结算一行（例：2025-10 共 93 行）。
- 时间与 REST 一样，带结算整点后 0–5 秒的处理延迟。
- 发布时间：下个月 1 日约 02:00 UTC（`last-modified` 例：2026-10 文件为 2026-11-01 02:00:37Z）。当月文件返回 404。
- 覆盖范围：从 2020-01 起（2019-12 返回 404），远超 365 天。

## 接入方式（与 OKX 归档相同的做法）

- `withGateArchive` 包住 01 的 REST 来源，API 标识为 `/futures/usdt/funding_rate+funding_applies`，`maxDays` 365。
- 7、30、90、180 天的分段仍走 REST。终点早于"截止时间 − 180 天"的分段，也就是 365 天分段，按月从新到旧读归档。
- **运行时逐条核对**：每次从头读取 365 天分段时，先用 REST 读取"Gate 的 180 天下限"至"下限所在月的下一个月末"，再下载这两个月的归档文件，要求这段时间内两边每条记录的原始时间和费率完全相同（任何一边多一条、少一条都不行），否则报错 `history-archive-mismatch`。这段重叠至少包含一个完整月，所以核对不会是空的。REST 一页不够时（如 1h 周期）按最旧一行往回翻页。
- **出处**：每页的记录只标注它所在月份的归档文件。核对用的 REST 请求排在前面，该页自己的归档文件最后下载；若该页月份也是核对月，就复用同一次下载。核对的 REST 响应和文件哈希写入该页的 `rawHash`。续读后续月份时不重复核对。
- 以下情况都会报错，不会当作空历史：
  - 文件不是 gzip
  - 空文件；有表头、科学计数法、非整点（60 秒以上）或不属于该月的记录
  - 同一小时重复，或记录倒序
  - 当月尚未发布（404）
- 读取量：冷启动时每条腿 4 页 REST、核对 1 页 REST、归档 8 个月（365 天分段的 7 个月，加核对多出的 1 个月），共 13 次请求。每次结算按同样数量重读；BTC 和 ETH 合计每轮 26 次，远低于 Gate 每 10 秒 200 次的限额。

## 没有采用的做法

REST 只传 `to`（不传 `from`）时也能读到 180 天以前的数据，每次大约返回 `to` 之前 30 天。这个 30 天的默认窗口没有写进文档，只是现象，所以生产不依赖它，只在上面的离线对照里用来交叉核对。
