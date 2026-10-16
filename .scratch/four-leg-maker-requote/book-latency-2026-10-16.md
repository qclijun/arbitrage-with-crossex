# 盘口来源与延迟诊断 — 2026-10-16

全程只读。未修改运行服务、代理配置、交易代码、订单或持仓。测速在独立进程中完成，没有启动第二个交易引擎或打开 SQLite 写连接。

## 结论

1. 本笔 Gate Maker 使用 Gate 原生公开 REST 永续盘口；HL 对冲数量校验使用 HL 原生公开 REST 盘口。订单经 Gate CrossEx 签名接口发送，不是原生 venue 下单接口。
2. 本机小样本的 Gate 盘口 HTTP 耗时中位数 134 ms，HL 157.5 ms；不等于原实盘时的盘口年龄。
3. 代码丢弃了上游时间戳并设置 `ts=Date.now()`，不能从现有记录追溯原实盘每次决策的真实盘口年龄。原笔四次拒绝各自的精确延迟仍为 UNKNOWN。
4. 优化空间有实测支持：独立进程对同一已结束订单交替比较当前连接与复用代理 HTTPS 连接，热查询中位数 844 ms → 133 ms，下降约 84.2%。这只证明该只读查询链路可改善，不证明真实下单耗时同幅下降。

## 数据链路

`Gate/HL 原生公开 REST → fetchVenueBook → gateVenue.bestQuote/refPrice → 1s 价格缓存 → 单写者 tickPair 决策 → Gate CrossEx 创建订单 → CrossEx getOrder 确认`

| 用途 | 来源 |
|---|---|
| Gate ETH 永续盘口 | `GET https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=ETH_USDT&limit=50` |
| Gate 合约数量乘数 | 首次请求 `/futures/usdt/contracts/ETH_USDT`，随后进程内缓存 |
| HL ETH 盘口 | `POST https://api.hyperliquid.xyz/info`，只读请求体 `{type: 'l2Book', coin: 'ETH'}` |
| 引擎自动报价 | `src/engine/venueGate.ts:237`，调用上述公开盘口函数，不读取浏览器画面 |
| 界面参考盘口 | `/api/books/:symbol`，另有 2s 服务缓存；可见页面约 2.5s 轮询 |

界面的轮询与引擎的 1s 缓存是两条路径，不能把 UI 2.5s 轮询直接当作下单延迟，也不能将它们机械相加。
测速使用本项目现有 `.env`，启用了 `GATE_PROXY`；未输出代理地址或任何凭据。

## 当前实测

采样窗口约为 2026-10-16 02:29–02:32（UTC+8）；为低负载短时样本，不作为 P95/P99 或长期 SLA。

| 指标 | 样本 | 最小 / 中位 / 最大 |
|---|---:|---|
| Gate 盘口 HTTP 往返 | 6 | 128 / 134 / 492 ms |
| HL 盘口 HTTP 往返 | 6 | 124 / 157.5 / 702 ms |
| Gate 接收时间减响应 `current` | 6 | 54 / 54 / 131 ms |
| HL 接收时间减盘口 `time` | 6 | 469 / 630 / 871 ms |
| 生产本地 health 往返 | 6 | 1 / 2 / 12 ms |
| 生产本地 `/api/orders/:id` 往返（含上游查询） | 6 | 810 / 1082 / 1307 ms |

Gate 第一次 `fetchVenueBook` 合计 1002 ms，其中合约元数据请求约 859 ms；盘口请求本身约 139 ms。元数据只在独立测速进程首次调用时读取，不能当作每次盘口的固定成本。
HL 第一笔 HTTP 为 702 ms；其余约 124–351 ms。具体长尾原因未分解到 DNS、握手、代理路由或服务处理阶段。

源时间差不是纯网络延迟：包含上游快照生成/刷新与两端时钟差。系统显示 `NTPSynchronized=yes`，但未独立测得每个交易所的时钟偏移，不能把上述差值称作严格单向网络延迟。
Gate `current` 是响应生成时间，`update` 是盘口变更时间，两者含义不同。HL 多次响应出现相同 `time`，快请求也可能取得较旧快照。

## 引擎本地等待

- `PRICE_TTL_MS=1000`。缓存命中在本次独立实例测试中为 0 ms、无上游 HTTP 请求，但价格仍来自旧快照。
- TTL 从拉取开始时计时，并非返回后固定再延迟 1 秒；慢请求超过 1 秒时，返回后缓存可能已到期。
- `best`、`touch` 和 `ref` 的缓存键分开；不是一个带源时间戳、供所有用途共享的盘口快照缓存。
- `NormalizedBook.ts` 由 `assemble()` 写为本机 `Date.now()`，Gate `current/update` 和 HL `time` 没有被保留；`bestQuote` 再将结果缩减为价格字符串。
- 引擎每轮先查询 OPEN/PENDING 订单状态，再获取价格、决策和执行。活跃动作后延迟 150 ms，空闲轮后延迟 1000 ms，实际轮间隔还要加网络请求时间。
- 存在已确认对冲义务时，`needBest` 仍可能为 true，随后按顺序请求 `bestA` 和 `refB`；这使紧急对冲可能等待不参与该次优先对冲决策的 Maker 报价。
- 创建订单后还会同步调用一次 `getCrossexOrder` 获取快照；因此一次动作不等于只有一次上游 HTTP。

## 原实盘订单的时间差

Deal：`87c3d192-8d7f-450d-a5de-d48d77c2755b`。

| client ID 后缀 | 本地订单登记 → 交易所 `createTime` |
|---|---:|
| A1 | 800 ms |
| A2（拒绝） | 826 ms |
| A3（拒绝） | 928 ms |
| A4（拒绝） | 4240 ms |
| A5（拒绝） | 776 ms |
| A6（Maker 成交） | 803 ms |
| B1（对冲） | 779 ms |

这是不同系统时间戳之差，包含本地登记后处理、网络、CrossEx 转发及时间偏移；既不是原盘口请求 RTT，也不是严格测得的交易所接收单向延迟。
四次 POC 拒绝能够证明到达时会吃单，但不能仅凭这些记录断言“盘口 API 延迟导致四次拒绝”。

## 连接复用对照实验

独立进程、相同项目配置与 SDK、同一已结束订单，每轮交替执行当前方式与池化代理 HTTPS 方式，均只调用 `getCrossexOrder`。
池化方式使用 `HttpsProxyAgent(keepAlive=true)`，显式设置 `proxy=false`，避免第二层 Axios 代理；仅存在于测速进程。

| 方式 | 冷调用 | 后续 4 次热调用 | 热调用中位 |
|---|---:|---|---:|
| 当前客户端配置 | 1331 ms | 819、836、852、956 ms | 844 ms |
| 独立池化连接 | 1131 ms | 143、134、132、128 ms | 133 ms |

现有公开盘口代码已经设置代理连接池，不应再把“给盘口添加 keep-alive”当作尚未实现的优化。
`makeClients` 的签名客户端没有同样显式的代理池配置。对照支持优先评估这层连接复用；未独立记录 TCP/TLS 事件，不能把全部差额严格拆成 TLS 建连成本。

## 优化优先级（设计建议，未实施）

1. 补齐行情与订单链路观测：源更新时间、响应生成时间、本地请求开始/接收/决策/发单/回执时间、缓存命中、触发时买卖一、client ID；避免记录密钥或签名。
2. 在保持超时、代理、安全和 UNKNOWN 语义的前提下，评估将已实测有效的代理 HTTPS 连接复用用于 CrossEx 签名客户端。先离线回归和只读长时对照，再在后续计划交易中验证真实下单/确认耗时。
3. 已确认成交的对冲优先路径跳过不用的 Maker 报价；独立读取可并发或预取，但所有交易写操作仍由同一个循环执行，保持每 tick 最多一次写请求。
4. 为活动 Maker 用 Gate `futures.book_ticker`、HL `bbo/l2Book` 推送维护带源时间和接收时间的最新盘口；断线、超龄、无效或不同步数据必须标为不可报价，保留 REST 回退。实际改善需要独立测速，不承诺 WebSocket 必然比 REST 快。
5. 有源年龄证据后再决定是否缩短 1s 缓存或在拒绝后使相关缓存失效。仅全局调小 TTL 会增加流量与阻塞，不能消除 CrossEx 下单在途风险。

任何优化都保留 Post-only；不能靠取消它来减少“拒绝次数”。WebSocket 也无法保证报价在送单过程中永远不会穿过对手价。

## 官方与本机证据

- [Gate REST 盘口](https://www.gate.com/docs/developers/apiv4/en/futures)：`current/update` 含义，Context7 官方来源。
- [Gate Futures WebSocket](https://www.gate.com/docs/developers/futures/ws/en/#best-askbid-subscription)：`futures.book_ticker` 及源时间 `t`。
- [HL WebSocket](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)：`bbo/l2Book`、盘口 `time`。
- 原始本机测速输出：`/tmp/requote-book-latency-probe.json`、`/tmp/requote-order-read-latency.json`、`/tmp/requote-order-transport-probe.json`。
- 只读临时复现脚本在同名 `/tmp/*.mts` 或 `.py` 中；没有改动产品文件或运行实例。
