# 工单 23：五源官方限流文档与 CCXT 能力边界

检索日期：2026-10-30。只读取文档与官方代码仓库，未请求交易所业务/账户 API、未诱发限流。本文记录文档保证；不推测本进程实际消费、当前出口 IP 余量或本地实现。以下“未规定”限于已列文档，没有宣称整个产品不存在该能力。

## 可直接用于工单的结论

- 五源没有统一的“等待 60 秒即可恢复”官方保证。Aster/Binance 的 IP 禁封可持续 2 分钟至 3 天；Bybit 的特定 IP 403 要求至少等待 10 分钟。其余场景须区分具体配额与服务端信号。[Binance IP Limits][B1]、[Aster IP Limits][A1]、[Bybit HTTP IP limit][Y1]
- IP 限额约束共享该出口的请求；只知道文档容量、本进程次数或 CCXT 实例计数，不能知道其他进程的消费和此刻实际剩余额度。这是依据各源计数维度与 CCXT 实例隔离作出的推论；一次响应头快照也不能保证随后仍有余量。[B1]、[A1]、[O1]、[Y1]、[H1]、[C1]
- `Retry-After` 支持整数秒或 HTTP-date 是 HTTP 标准语法，不能据此宣称场所一定返回该头。本文所查五源相应页面均未找到这种统一返回承诺；尤其不能把 Binance Spot/Mining 的承诺移植到 USDⓈ-M。[RFC 9110 §10.2.3][R1]

## Binance：USDⓈ-M Futures

适用公开端点是 `GET /fapi/v1/fundingRate`；它与 `/fapi/v1/fundingInfo` **共享 500 次 / 5 分钟 / IP**。fundingInfo 同时标注 IP weight `0`，仍受这个共享次数池限制；不能以 weight 0 推论无限调用。[Market Data → Get Funding Rate History / Get Funding Rate Info → Request Weight][B2]

通用 USDⓈ-M 文档规定 `exchangeInfo.rateLimits` 提供各类限制，`X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)` 表示 IP 已用权重，限额按 IP 而非 API key。若用 `X-MBX-USED-WEIGHT-1M` 算分钟权重余量，必须配对 `rateLimitType=REQUEST_WEIGHT, interval=MINUTE, intervalNum=1` 的容量；**不能将该分钟权重头视为上述 500/5min 共享池的剩余额度**（计数单位/周期不同，属文档推论）。没有相应池的可信遥测时，该池实际余量应为 UNKNOWN。[General Info → LIMITS / IP Limits][B1]

HTTP `429` 表示请求超限，需退避；继续发送可触发 `418` IP 禁封，重复违规禁封从 2 分钟至 3 天；3 天是文档范围上界，并非每次禁封时长。业务码 `-1003` 是 `TOO_MANY_REQUESTS`，错误文本还可能提供 IP 禁封截止时间。[General Info → HTTP Return Codes / IP Limits][B1]、[Error Codes → -1003][B3]

**文档边界：**所查 USDⓈ-M General Info 的全文未出现 `Retry-After`；未查到此 500/5min 池的专用 remaining/reset 响应头或固定窗口重置时点承诺。因而“必有秒数 Retry-After”“必支持 HTTP-date”“无头时等 60s 必恢复”都不能作为该产品官方事实。旧 Context7 摘录中的 Retry-After 秒数段落指向 Mining，已排除。[B1]、[B2]

## Aster：V3（现用接口）

官方仓库 `V3(Recommended)` 的 `GET /fapi/v3/fundingRate` 标注 weight `1`。`/fapi/v3/exchangeInfo.rateLimits` 是限额来源，文档示例 `REQUEST_WEIGHT` 为 `2400 / MINUTE / intervalNum=1`；**这是文档示例，不是此次业务 API 实测容量**。[V3 → Get Funding Rate History / Exchange Information / Rate limiters][A1]

IP Limits 规定 MBX used-weight 响应头、按 IP 而非 API key 计数。匹配分钟头与同周期容量可得到响应时的分钟权重快照，不能预知其他进程的后续消耗。HTTP `429` 表示超限；不退避可触发 `418`，重复违规禁封 2 分钟至 3 天。`-1003` 涵盖请求过多与含禁封截止时间的错误文本。[V3 → LIMITS / IP Limits / HTTP Return Codes / -1003][A1]

**文档边界：**V3 文档未检索到 `Retry-After`、remaining 或 reset 响应头的承诺，也没有 Binance 那条 fundingRate/fundingInfo 共享 500/5min 规则；不能借 API 相似而移植。V1(Legacy) 已单独核对路径，未用来替代 V3 的适用依据。[A1]

## OKX：public funding history

`GET /api/v5/public/funding-rate-history` 标注 **10 次 / 2 秒，IP + Instrument ID**；因此计数键包含合约，不能把它改称整个 IP 的唯一总池。通用规则说明未认证 public REST 按 IP、private REST 按 User ID；订单相关 REST/WS 共享规则属于交易接口，不能移植为此公开端点的共享池。[Public Data → Get funding rate history][O2]、[Overview → Rate Limits][O1]

错误表同时列出业务码 `50011` 的 HTTP `200` 与 HTTP `429` 两种行；`50040` 对应 HTTP `200`（操作频繁、稍后重试）。因此仅检查 HTTP429 不能涵盖文档列出的限流业务响应。[Error Codes → General Class][O3]

**文档边界：**所查端点、Rate Limits 与错误表未规定该端点的 remaining/reset 头、`Retry-After` 秒或 HTTP-date 保证、固定恢复等待秒数或 `418` 禁封规则；“2 秒周期”本身不能证明收到错误后等 2 秒即保证成功。[O1]、[O2]、[O3]

## Bybit：public funding history

`GET /v5/market/funding/history` 是公开资金费历史接口。通用 HTTP IP 规则为默认 **600 次 / 5 秒 / IP**，覆盖指定公共域名及区域域名流量。端点页及所查 API Rate Limit Table 没有给这个 funding history 端点单列数值上限，故不从交易接口表推导其 UID 限额。[Get Funding Rate History][Y2]、[Rate Limit Rules → HTTP IP limit / API Rate Limit Table][Y1]

API Rate Limit 章节另定义按 UID 的每秒滚动窗口；`X-Bapi-Limit-Status` 是**当前端点**剩余次数，`X-Bapi-Limit` 是当前端点限额，`X-Bapi-Limit-Reset-Timestamp` 仅在已超限时表示该配额的重置时间，否则只是当前时间戳。不能把这些值当作整个出口 IP 的 600/5s 余量或 IP 解封时间；公开未认证请求的具体头覆盖须由实际响应另证。[API Rate Limit][Y1]

`retCode=10006` 表示 API 超限；HTTP429 表示系统级频率保护。`10429` 在 **WS OE General code** 表中，不能当成本 REST 接口必返回的业务码。HTTP403 有多种原因（IP超限、空 JSON 的 GET、美国 IP），不能一律认定为限流。[Error Codes → HTTP Code / WS OE / UTA][Y3]

但是，若明确收到 **`403, access too frequent`**，官方要求终止全部 HTTP 会话并至少等待 **10 分钟**，禁封自动解除；这不是普通 60s 冷却场景。所查页未规定 HTTP429/10006 统一等待秒数，也未承诺 `Retry-After`。UID 端点 reset 不应替代该 IP 禁封等待。[HTTP IP limit / API Rate Limit][Y1]

## Hyperliquid：info fundingHistory

公开资金费历史使用 `POST /info` 的 `type=fundingHistory`。[Info endpoint → Retrieve historical funding rates][H2]

REST 按 IP 聚合限额 **1200 weight / 分钟**。`fundingHistory` 属默认基础 weight **20** 的 info 请求，且列入**每返回 20 项额外增权**的端点列表。因此不能一律按每页 1 次或仅固定 20 估算成本；所查文字未明确不足 20 条时的舍入公式，本文不补造 floor/ceil 规则。[Rate limits → per IP address][H1]

**文档边界：**所查 Rate limits / Info endpoint 未给 fundingHistory 的 remaining/reset 响应头、`Retry-After`、HTTP429 精确等待时间或固定恢复规则。文档中的“受限后每 10 秒一次”属于 **address-based actions**，明确不适用于 info；不能用来解释 fundingHistory 的 IP 限流恢复。[Rate limits → Address-based limits][H1]

## CCXT 官方补充：配置不等于场所遥测

Context7 实际执行了 library resolve 与 `/ccxt/ccxt` Manual 查询，再核对 CCXT 官方 `wiki/Manual.md` 当前内容。Manual 的 `rateLimit` 单位为毫秒，按 endpoint cost/weight 控制本地节奏；`enableRateLimit` 默认开启。Manual 明确说明单个数值不能表达所有端点、账户和突发规则，参数需按业务调整。这些是客户端调度规则，不能替代上面的场所计数维度与封禁要求。[Manual → Exchange Properties / Rate Limit / What the rateLimit number means][C1]

每个 exchange 实例各有自己的限流器，彼此不可见；反复销毁/新建实例还会重置本地限制状态。Manual 建议复用实例。故同进程多实例、其他进程/主机共享出口 IP，均不能靠一个 CCXT 实例得出真实剩余配额（此句是基于实例隔离的推论）。[Manual → One Rate Limiter Per Each Exchange Instance][C1]

`returnResponseHeaders=true` 可在结果 `info.responseHeaders` 暴露响应头，但 Manual 明确它只支持对象响应，**不支持列表或字符串响应**。它既不保证某场所会发头，也不把某端点头变成全 IP 余量。本文未将各 venue 的 CCXT 硬编码 `rateLimit/cost` 列作场所承诺；未确认本仓库是否使用 CCXT，此项留给实现对照。[Manual → Exchange Properties][C1]

## 交接

目标是补足工单23五个公开资金费历史源的限流依据，已完成官方页面、Aster现用V3及CCXT Manual核对，证据集中于本文件。未修改实现、未新增提交、未访问业务或账户API；未运行构建测试，因为本子任务仅文档研究。关键未规定项是各池实时剩余、部分端点的重置头/Retry-After承诺及Hyperliquid429恢复时点。根任务仍需将这些文档规则与本地reader、collector和共享出口观测分别对照；任何本地60s兜底都不能写成五源统一官方恢复保证。

[B1]: https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info#ip-limits
[B2]: https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
[B3]: https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code
[A1]: https://github.com/asterdex/api-docs/blob/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md
[O1]: https://www.okx.com/docs-v5/en/#overview-rate-limits
[O2]: https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate-history
[O3]: https://www.okx.com/docs-v5/en/#error-code-rest-api-general-class
[Y1]: https://bybit-exchange.github.io/docs/v5/rate-limit
[Y2]: https://bybit-exchange.github.io/docs/v5/market/history-fund-rate
[Y3]: https://bybit-exchange.github.io/docs/v5/error
[H1]: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
[H2]: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
[C1]: https://github.com/ccxt/ccxt/blob/master/wiki/Manual.md
[R1]: https://datatracker.ietf.org/doc/html/rfc9110#section-10.2.3
