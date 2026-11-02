# 03: Gate 365 天窗口

Type: research
Status: resolved
Blocked by: 01

**What to build:** 确认 Gate 能否通过官方来源提供 365 天的已结算资金费历史，从而让 Gate 配对在 365 天窗口也能排名。

背景：Gate 公共 REST 历史只能回溯 180 天（见 01）。OKX 遇到过同样的限制，后来用官方月度归档文件补齐。

- [x] 调研 Gate 是否有官方的历史资金费归档（批量下载或数据服务），记录来源、格式、覆盖范围，以及它和 REST 记录能否逐条对应。
- [x] 如果有可信来源：在 01 的 Gate 历史上按 OKX 归档的方式补齐 365 天，并保证归档和 REST 重叠的部分逐条一致；365 天窗口可排名。
- [x] ~~如果没有：365 天窗口保持"不支持"，在本票 Answer 中记录调研过的来源和结论，然后关闭。~~ 不适用：找到了可信来源。

## Comments

- 2026-11-01：用户同意建票；依赖 01 的 Gate 历史接入。
- 2026-11-02：Claude 认领。01 已 resolved，解除阻塞。

## Answer

Gate 有可信的官方来源，365 天窗口已可排名。

- 来源：Gate 官方[历史数据下载页](https://www.gate.com/developer/historical_quotes)的 `futures_usdt/funding_applies`，说明为 "Executed funding rate"。预测费率是另一个数据集 `funding_updates`，没有采用。
- 格式：每个合约每月一个 gzip CSV，无表头，`秒级时间,费率`，升序；时间与 REST 一样带 0–5 秒处理延迟。下月 1 日约 02:00 UTC 发布，当月为 404；覆盖从 2020-01 起。
- 逐条对应：2025-09 至 2026-10 共 14 个月，BTC、ETH 各 1278 条与 REST 逐条一致（原始时间、费率文本都相同，两边无多余行）。证据见 [evidence/gate-archive-history.md](../evidence/gate-archive-history.md)。
- 实现：`src/core/funding/gate-archive.ts`，按 OKX 归档的方式包住 01 的 REST 来源。
  - 7–180 天分段仍走 REST，365 天分段按月从新到旧读归档。
  - 每次从头读取都先用 REST 核对"180 天下限至下一个月末"（至少一个完整月），不一致就报错 `history-archive-mismatch`。
  - 每页只标注它自己的归档文件为出处。
  - 空文件、格式异常、重复、倒序、未发布的月份都报错，不当作空历史。
- 没有采用：REST 只传 `to` 能读到 180 天以前的数据，但默认窗口没有文档，只用于离线对照。
- 代价：每条腿每轮 13 次请求，BTC 和 ETH 合计 26 次。
- 回归：`tests/unit/funding-gate-archive.test.ts`、`tests/unit/funding-gate-ranking.test.ts`。
