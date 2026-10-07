# #02 官方公开来源核验

核验日期：2026-10-07 Asia/Taipei。仅无认证公开 GET；未查询账户、签名、模拟或交易接口。以下是数据契约证据，不是可成交/展期就绪证明。

## 来源与版本

- [当前 OpenAPI JSON](https://api-boros.pendle.finance/apis/docs-json)，[交互文档](https://api-boros.pendle.finance/apis/docs)：`info.version=20261007.0403-08c05ae`；本次下载 SHA-256 `b8f02917d3f94176f74ce6831cfa55b8979df6b2334584ea4b4412e07caa9ecd`。
- [API 入口说明](https://docs.pendle.finance/boros-dev/Backend/api)：当前公开挂载为 `https://api-boros.pendle.finance/apis/`；`api.boros.finance/open-api/` 已 deprecated。
- [订单簿机制](https://docs.pendle.finance/boros-dev/Mechanics/OrderBook)、[开发术语](https://docs.pendle.finance/boros-dev/Backend/glossary)、[YU 定义](https://docs.pendle.finance/boros-academy/the-basics/chapter-1-yield-units-yu)。
- [CU 限额](https://docs.pendle.finance/boros-dev/Backend/computing-units)、[延迟与 AMM 合并说明](https://docs.pendle.finance/boros-dev/Backend/best-practices)。后者还使用旧路径；路径/参数以本次新 OpenAPI 与实际 GET 为准，旧路径延迟表不自动证明新挂载 SLA。

Context7 按项目要求在 sandbox 外先 `library Boros`，再 `docs /pendle-finance/sdk-boros-public` 查询 YU/size 单位；结果主要指向 SDK 旧 `core` 文档，不能覆盖本次新 OpenAPI 的更具体证据。Agent Reach web channel 的 Jina Reader 在 sandbox 内 DNS 失败，sandbox 外 TLS EOF；随后以官方网页浏览与直接官方 GET 完成核验。

## 可复现请求与覆盖

```sh
curl -fsSL 'https://api-boros.pendle.finance/apis/docs-json'
curl -fsSL 'https://api-boros.pendle.finance/apis/v1/assets?isCollateral=true'
curl -fsSL 'https://api-boros.pendle.finance/apis/v1/markets?isMatured=false&isUiWhitelisted=true&limit=200'
curl -fsSL 'https://api-boros.pendle.finance/apis/v1/markets/by-ids?marketIds=197'
curl -fsSL 'https://api-boros.pendle.finance/apis/v1/markets/order-book?marketId=197&tickSize=0.0001&includeAmm=false'
```

| 路径 | 字段/覆盖（来自新 OpenAPI operation 与 schema） |
| --- | --- |
| `GET /v1/assets` | `results[]` 包含 `tokenId,id,symbol,decimals,usdPrice,isCollateral`；未分页，只有白名单资产；可按 `isCollateral` 过滤。 |
| `GET /v1/markets` | `results[],resumeToken,syncStatus`；按不可变 `marketId` 升序；默认 50、最多 200；传回 `resumeToken`，直到 `null`。永远排除非 whitelisted market；未指定 `isMatured` 时含到期 market；`isUiWhitelisted=true` 才匹配官网可见范围。 |
| `GET /v1/markets/by-ids` | `marketIds` 逗号分隔，1–100 个正整数；按请求顺序，重复 ID 会重复；缺失/非白名单 ID 静默省略。`resumeToken=null`。必须逐 ID 对照返回结果，省略不等于无流动性。 |
| `GET /v1/markets/order-book` | 必需 `marketId,tickSize`；`tickSize ∈ {0.0001,0.001,0.01,0.1}`；`long,short,syncStatus`；每边仅 best 50 档；没有分页游标或截断字段。到期返回 410 `MARKET_MATURED`。 |
| `GET /v1/amm/states` | 可选后续独立 AMM 来源；按 1–100 个 `marketIds`，无 AMM/缺失/非白名单静默省略。本次未请求，也不把省略解释为零 AMM 深度。 |

本次列表返回 32 个未到期 UI 白名单 market，`resumeToken=null`；这只证明该过滤范围本次完成，不代表协议所有 market。资产返回 5 种抵押资产；ETH 对应 `tokenId=2,id=ETH,symbol=WETH,decimals=18`。资产响应无源时间字段。

## market 身份与单位

以 `marketId` 为主键，同时保留 `address, platform.platformId/name, metadata.name/underlyingSymbol/fundingRateSymbol, tokenId, imData.maturity`。`metadata.name=ETHUSDC` 是交易对展示名，不能替代 venue 或 collateral；同一交易对跨 venue/到期独立。`imData.maturity` 是 Unix 时间，本次 `197=Binance ETHUSDT,tokenId=2,maturity=1793318400`（2026-10-30 00:00 UTC）。

| 指标 | 原始字段与单位 | 转换/边界 |
| --- | --- | --- |
| 24h Volume | `data.volume24h`，number，已归一化 YU；schema 明确滚动 24h 内 `sum(abs(trade.size))` | 不再除 `1e18`；是 market 交易名义量，不是账户成交或抵押存款。是否所有 OTC 路由也进入 `trade` 统计，未给枚举覆盖证明，记录 `UNKNOWN: trade-route-coverage-undocumented`。 |
| Notional OI | `data.notionalOI`，number，已归一化 YU；schema 明确当前**单边** OI，链上 `getOI()` 除 2 | 不再除 `1e18`、不得再除 2；保留 `oiConvention=one-sided`；不是成交量或深度。 |
| 订单档位数量 | `long.sz[i]/short.sz[i]`，bigint string，18-decimal YU | 用精确十进制/BigInt 保留原值，显示 `raw/1e18`；与 native token decimals 无关。 |
| YU / sizeToken | 一个 YU 表示一单位抵押资产名义规模的资金费率敞口；本项目 `sizeToken` 可对应归一化 YU 数量 | ETH market 中 1 YU 对应 1 ETH **名义敞口**，不是 1 ETH 保证金或 YU 现金价值；YU 价值随利率及到期剩余期变化。 |
| USD 名义量 | `YU × collateral.usdPrice` | 仅近似换算；价格时间缺失则 USD 新鲜度 UNKNOWN；不能用 APR 或保证金乘数转换。 |

`volume24h` 的 rolling 语义与来源是已文档化；统计自身的刷新周期/窗口截止时刻/独立更新时间没有字段与保证，记为 `UNKNOWN: volume-update-time-undocumented`。`syncStatus` 只能表示后端/链同步状态，不能冒充成交统计更新时间。

## APR 双边方向与 AMM

新 OpenAPI 的 **operation description** 明确 `ia[i]` 是有符号聚合整数索引，`APR=ia[i]×请求tickSize`；它不是链上原始 tick，不能再套 `1.00005^(tick×tickStep)-1`。APR 单位为小数（`0.053=5.3%`）；负 APR 有效。该 operation 与 `SideTickResponse.ia` 的 schema 文案发生冲突：后者写成 decimal APR。实际 `197` GET 返回 `long.ia[0]=530,short.ia[0]=581`，与 market APR 约 5–6% 一致，支持 operation 的索引解释。后续 #03 应固定这一证据并对接口变更拒绝猜测。

- `long=bids`，APR 降序，最高 first；`short=asks`，APR 升序，最低 first。机制文档证明 rate-time 优先方向；taker long 消耗 short/asks，taker short 消耗 long/bids。
- 只在同次快照双边有效时，`spreadApr=bestAsk-bestBid`；显示百分数差乘 100，显示 APR bps 乘 10000。单边空缺为 Spread UNKNOWN，负 APR 不应被过滤；异常 crossed/非有限值不可修正为零。
- `includeAmm=false` 默认只有静置订单；`true` 在截断前合并 AMM。两份盘口不能直接相加；UI 合并盘口与纯 CLOB 要明确不同 scope。合并响应不分离每档 AMM 贡献。
- 每边 50 档是**服务器硬截断**；50 档意味着可能有更多档，不能声明全深度。少于 50 只观察到未触及 cap，文档未另外声明全簿完整保证；保存返回档数/cap、`coverage=returned-levels`。窗口深度必须证明所需范围已覆盖；超出返回边界不得当零。
- AMM 连续利率与静置订单离散档位不同；AMM 可因利率超出范围停止服务。本次未核验 AMM 单独深度，不给保证金或可成交结论。

## 时间、限额与本次小样本

`MarketsSyncStatusResponse` 的 `blockNumber/timestamp` 是查询时最新块；`SyncStatusResponse` 是最新 fully processed 块。schema timestamp 未明确秒单位；实测值 `1791353356` 与 HTTP Date `2026-10-07 06:09:16 GMT` 一致，按 Unix 秒处理是实证推断，契约需显式标注并验证时间量级。应另外保留本地 `fetchedAt`，不能把请求完成时间覆盖源时间。不同 GET 的块号/时间独立，不是原子快照。

| 实测请求 | 有界响应证据 |
| --- | --- |
| market `197` | `volume24h=939.378609758163 YU,notionalOI=1861.4854741222807 YU`；`syncStatus={blockNumber:512479175,timestamp:1791353356}`。 |
| 纯 CLOB `197`,tickSize=0.0001 | long 18 档、short 34 档，数组长度匹配；首档 bid `0.053`,size `69.938674634487452773 YU`；ask `0.0581`,size `0.0039 YU`；`syncStatus={blockNumber:512479177,timestamp:1791353356}`。桶化边界与 market `bestBid/bestAsk` 原始利率可有差异。 |
| UI 白名单列表 | 32 条，cursor null；`syncStatus={blockNumber:512479311,timestamp:1791353393}`。 |

CU 文档发布免费 IP 固定窗口预算 `200/min,400000/week`，耗尽 429；market list/book 各 2 CU，assets 1 CU，by-ids 单 ID 1 CU、多 ID 2 CU。本次 by-ids 响应实际 `x-computing-unit=1,x-ratelimit-limit=200,x-ratelimit-remaining=199,x-ratelimit-reset=1791353400,x-ratelimit-weekly-limit=100000000,x-ratelimit-weekly-remaining=99900759,x-ratelimit-weekly-reset=1791417600`。**实际周预算与发布文档不同**，保存有效响应 headers；不将本次更高额度当稳定承诺。429 按可用 reset/backoff 重试，不新建高频轮询器。

## 截图人工对照：OI 口径差异

截图来源日期 UNKNOWN、仅已舍入显示值；不能证明当前值。截图 URL market 197 是背景页面，弹出的 ETHUSDC 分组不是 market 197。venue 根据本次 metadata 平台交叉核验：第一组 Hyperliquid，第二组 Lighter。

| venue / 到期 / ID | 截图 24h Volume / OI (ETH) | 本次公开列表 volume24h / **单边** notionalOI (YU) |
| --- | --- | --- |
| Hyperliquid / 2026-10-30 / 196 | 1114.52 / 15031.9 | 1114.5229110234611 / 7515.961077406483 |
| Hyperliquid / 2026-11-27 / 209 | 45.293 / 2427.87 | 45.29297811 / 1213.9339560623855 |
| Hyperliquid / 2026-12-25 / 128 | 69 / 4541.79 | 77.5 / 2279.3969452727392 |
| Lighter / 2026-10-30 / 199 | 929.164 / 1524.53 | 929.1641754551923 / 762.2652212572747 |
| Lighter / 2026-11-27 / 212 | 6.03148 / 554.298 | 6.031481481481468 / 277.1490074074074 |

四行静止数值与截图 volume 匹配且 screenshot OI 约等于 API 单边 OI×2，符合新 schema 的 halved 约定；这是强对照证据，**未取得官网 OI 计算代码，不能宣称截图每行永远双边口径**。保留官网显示口径 `UNKNOWN: ui-oi-definition-unverified`，独立显示明确的 API 单边 OI。12月行已变动，不能为匹配截图倒推实时值。截图未提供 Spread/深度。

## 后续票必须保留的 UNKNOWN

资产价格源时间、volume 统计独立更新时间/所有 trade 路由覆盖、官网 OI 算法、返回档之外的深度、AMM 单独数量、本次 UI 筛选范围外 market、请求失败/省略 market、缺侧盘口均不得补零。仅原始字段明确返回的零，在单位/范围/新鲜度有效时可作为已知零；本票没有账户、执行或展期安全含义。
