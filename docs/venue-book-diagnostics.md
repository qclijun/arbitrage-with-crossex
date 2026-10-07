# Opportunity 盘口失败诊断

`GET /api/opportunities` 的 `data.meta.venueBookFailures` 记录本次快照中缺失的永续盘口。`scripts/opportunity_screening.py` 将 close、roll 的诊断分别保存到 `report.json` 的 `evidence`，并在 `report.md` 的 `Perpetual book failure diagnostics` 中展示。

每条诊断包含：

- `symbol`：CrossEx 合约标识；符号规则不可用时为 `VENUE:BASE`。
- `category`：`timeout`、`http`、`network`、`tls`、`invalid-response`、`unsupported` 或 `unexpected`。
- `stage`：失败发生在 `setup`、`metadata`、`discovery` 或 `book`。
- `httpStatus`：失败请求的 HTTP 状态码；未记录到响应状态时为 `null`。HTTP 200 但盘口为空、合约规格无效或找不到市场时，分类为 `invalid-response`。
- `errorCode`：允许列表内的传输错误码；无法安全识别时为 `null`。
- `elapsedMs`：整个采集尝试的耗时，包括连接等待，以及必要的规格或市场发现请求。该数值不是仅 HTTP 响应耗时，也不代表整份 Opportunity 请求耗时。
- `observedAt`：采集结果的缓存观察时间（毫秒）；复用缓存时保持原时间。
- `stale`：缓存快照是否过期；新鲜的失败结果仍然没有可用盘口。

例如，`category=timeout; stage=book; HTTP=unavailable; errorCode=ECONNABORTED; elapsed=2,501 ms` 表示采集器捕获到超时错误，没有记录到 HTTP 状态码。`category=http; HTTP=429` 表示上游返回限流状态。

不保存原始错误全文、响应正文、请求头、代理地址或凭据。筛选脚本再次限制可保存字段和错误码。

本扩展保留已有代理、连接池、超时、缓存 TTL、失败返回空盘口和 UNKNOWN 判定。不会自动重试或绕过代理。签名下单客户端及订单不确定性处理没有修改。

旧报告没有这些诊断，无法补回历史错误。代码需在终端服务重启后才会由 API 输出新字段；本变更不自动重启服务。

## 2026-10-08 HYPE 超时调查与修复

`20261008T002804-b9131a48eaa6` 报告中的唯一盘口失败为 Hyperliquid HYPE：`ECONNABORTED`，耗时 2508 毫秒，未记录到 HTTP 状态。两个 HYPE 组合的 close/roll 使用同一失败快照，共产生四条 UNKNOWN。

现有配置允许每站八条在途连接，却只保留两条空闲连接。只读测试按 ETH、BTC、HYPE 同时请求同一站点：第一轮结束后仅留下两条空闲连接，后三轮 ETH/BTC 均复用连接，HYPE 均重新建立连接。代理 CONNECT 为 2–16 毫秒；HYPE 首轮 TLS 完成为 2302 毫秒，总耗时 2431 毫秒，后续新连接总耗时为 977、855、898 毫秒。这证明多符号扫描会稳定丢弃第三条连接并重复承担 TLS 握手开销；历史失败没有分阶段记录，无法证明那次 2508 毫秒具体耗在哪个阶段。

修复仅将每站空闲连接上限从 2 提升到 8，与现有在途连接上限一致。没有增加在途请求上限、调整超时、增加重试或使用陈旧盘口。合成 HTTPS/CONNECT 回归测试以三路并发扫描三轮：修复前九个请求建立五条隧道，修复后仅首次建立三条隧道。证书不可信时依旧返回空盘口。

通过修复后的实际采集器只读复测三轮 ETH/BTC/HYPE 并发，九次请求均为 HTTP 200，买卖各 20 档；HYPE 首轮 727 毫秒，后两轮 135、127 毫秒，后三个币种的连接均正常复用。这是当次网络条件下的样本，不是延迟上限保证。

公开盘口连接池也用于交易前的触价及参考价读取，因此该配置变化会影响它们的连接复用；签名下单、撤单、订单查询及订单不确定性处理没有修改。首次连接、上游主动断开和网络抖动仍可能超时，不能把此修复等同于保证所有盘口可用。
