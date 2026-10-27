# 工单09实施交接

目标：在08证据契约上实现有界后台历史采集与只读缓存。用户确认范围为端口：`FundingHistorySource`可注入，不含真实场所HTTP适配器、index.ts/AppDeps接线或只读API（18）。代码：`src/core/funding/history-cache.ts`（`view/evaluate/recheck`，读路径无来源依赖，结构上不能抓外网）、`history-collector.ts`（`createFundingHistoryRefresher().runOnce/start/stop`）。提交主题：`feat: add bounded funding history refresh and cache (09)`。

行为：每轮取共同cutoff，整轮结束原子发布，读者看不到半成快照。各腿按7→30→90→180→365窗口由新到旧分段读取，预算截断时仍能证明短窗口。失败保留旧证据及原verifiedAt，只更新lastAttempt；两腿cutoff不同时不拼接，按快照cutoff判UNKNOWN；两腿同为旧cutoff时只作stale观察。重抓到同期不同值时保留两版作冲突。预算采用07建议值，限流时停止该场所；对未知限额的场所默认按1秒间隔请求；在`call`外挂起的适配器工作及合约清单读取也受总时限约束。每15分钟一轮，在每刻钟后1分钟启动。

验证：新单测16/16通过（`tests/unit/funding-history-{cache,collector}.test.ts`），tsc及文件预算通过；根目录3305通过、8跳过；web build通过。默认并发`yarn verify`的web段有1–2个既有5秒UI超时（PairTicket／App指南，本票未改web），单独运行24/24通过，2 workers全量1710/1710通过。日志：`/tmp/ticket09-verify.log`、`/tmp/ticket09-web-limited2.log`、`/tmp/ticket09-pairticket-single.log`、`/tmp/ticket09-web-build.log`。

已知限制与待办：每腿每轮全量重读（08的observedAt≥cutoff要求），40次/场所仅够约8腿/轮，超出部分轮换且明确`budget-exhausted`；整轮结束才发布，早读的腿在下一轮发布前可能短暂stale。预算数值需在公开样本上实测延迟、429和响应头后校准。以下仍待完成：真实适配器（分页/上市/周期证据、HL毫秒映射）、Retry-After及权重头解析，以及18接线。
