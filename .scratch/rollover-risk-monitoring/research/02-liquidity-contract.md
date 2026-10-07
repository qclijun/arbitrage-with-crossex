# #02：Boros market 流动性来源与消费契约

Verified: 2026-10-07 Asia/Taipei
Scope: 第一阶段公开 market 数据；研究交付，不修改生产查询或交易逻辑。

本契约供 #03 快照获取、#04 指标计算、#05 展示使用。官方字段与只读请求证据见 [官方来源核验](02-official-sources.md)；[原票](../issues/02-boros-liquidity-sources.md) 的六项验收均需结合两份文档核对。文中“必须”是后续实现约束，“现有”描述当前代码，不表示缺口已修复。

## 既有适配器与缓存审计

基线 `19ec19ed3ae93ae3c85830123dffc4aab1fdee8c`。图索引 generation `2026-10-07T06:03:02Z`，对下表所依赖文件逐路径检查，无记录的覆盖缺口，并限量核对源码；此信号不是全库完整性证明。

| 项目入口 | 已实现行为 | #03/#04 必须保留或修正的证据缺口 |
| --- | --- | --- |
| [network](../../../web/src/lib/borosNetwork.ts#L4) | `apiBase=https://api-boros.pendle.finance/apis`，Arbitrum chain 42161 | 身份包含部署/chain，不能把另部署相同 market ID 混用 |
| [fetchBorosMarkets](../../../src/core/boros/client.ts#L347) | `isMatured=false&limit=200`；循环 resumeToken，按 marketId 去重 | 目前不返回 coverage/filter/cursor 元信息；遇重复页无新增会退出，即使仍有 cursor，不能因此报告 complete；后续须检验游标循环/不前进与分页完整性 |
| [fetchBorosMarket](../../../src/core/boros/client.ts#L377) | by-ids 查找已到期 market | 当前取首行，不证明请求与返回 ID 严格匹配；不能把缺席 ID 当市场不存在 |
| [normalizeBorosMarket](../../../src/core/boros/client.ts#L391) | marketId、tokenId、venue、base、maturity、APR、notionalOi 等 | 未保留 volume24h、源时间、原始平台/交易对字段；`Number(data.notionalOI ?? 0)` 会混淆缺失与零；必须保持旧消费者语义，新增严格流动性契约 |
| [fetchBorosOrderBook](../../../src/core/boros/client.ts#L442) | singular `/v1/markets/order-book`；tickSize=0.0001；short→asks 升序、long→bids 降序；sz/1e18 | 丢弃无效/非正档，客户端每侧 slice(0,500)，不记录舍弃/截断/源时间；官方服务更早已限制最佳 50 档，500 不能扩展覆盖；必须显式表示可见范围 |
| [norm18](../../../src/core/boros/client.ts#L82) | 转 Number 后 /1e18，非有限值回退 0 | 流动性输入不可用时不得调用此回退生成“已知零”；保留原始十进制字符串，校验后按用途转换，披露精度 |
| [resolveCollateralPricesUsd](../../../src/core/boros/client.ts#L778) | USDT 假设 1；其他从同标的 market.assetMarkPrice 取价 | 本次只识别复用入口，不认证该假设为新鲜真实 USD 报价；缺价/缺时间只能输出原生量和 USD UNKNOWN，不用标的价给不同 collateral 换算 |
| [opportunities route](../../../src/server/routes/opportunities.ts#L208) | 共用 markets/扫描 book 缓存；返回本地 observedAt/stale | 先筛 supported coin，又按组合/venue 筛盘口，只在 market entry 模式取 book；扫描页面的已取数据不是完整 Boros 市场全集 |
| [createPairPricer](../../../src/server/routes/borosPair.ts#L409) | markets、quote markets、trade book 独立缓存 | 只复用公共读取/缓存 seam，不调用 priceRequest、simulate/execute、签名与授权路径 |
| [TtlCache](../../../src/server/cache.ts#L71) | 合并同键读取；429 可返回旧值并标 stale | observedAt=fetch 完成的本地 Date.now()，是采集时间而不是上游数据时间；保留原缓存与 2 秒 per-key cooldown，不建设新轮询系统 |

当前 TTL（[常量](../../../src/server/cache.ts#L28)）：`boros:markets` 30 秒、`boros:book:<id>` 90 秒、`boros:markets:quote` 5 秒、`boros:book:trade:<id>` 3 秒。旧注释中“扫描 30 秒”不能替代常量。#03 复用调度，统计/盘口分别记录年龄；不将 quote/trade 缓存的短 TTL 宣称为市场流动性刷新保证。

调用路径经图 trace 确认：opportunities plugin 与 createPairPricer.loadTradeBook 调用 fetchBorosOrderBook；后者供 priceRequest 使用。本票不修改这些交易路径。

## 身份与字段状态

- 主键：`deployment/chainId + marketId`；同时保存原始 venue/platformId、完整 symbol（例如 ETHUSDC，与 base ETH 分开）、collateral tokenId/address/symbol、到期 Unix 秒、isMatured/whitelist/请求过滤。显示名不作为唯一身份。
- 上游未公开时请求范围使用 `isMatured=false` 与显式 `isUiWhitelisted`，白名单外不在可验证覆盖内；资产字段 `id` 是资产标识（如 ETH），不能假装 ERC20 地址。原始字段缺失不能通过 market 名称或相同标的的另一到期 market 猜测；未知 venue/symbol/maturity/collateral 明确缺失且保留 marketId。列表覆盖仅描述本次 whitelist/isMatured/filter 范围，不称“所有曾存在 markets”。
- 每个 measurement 至少有 `value | null`、`unit`、`source`（endpoint + field/query）、`sourceObservedAt | null`、`collectedAt`、`freshness`、`completeness`、`reason[]`、`marketKey`。列表和左右 book 的 coverage 独立，不用一个成功布尔值抹平部分失败。首期 volume 带 `rolling-24h` 与 `trade-route-coverage-undocumented` 限制，不承诺未文档化的 OTC 等所有路由均覆盖。
- `sourceObservedAt` 使用已核验字段及秒/毫秒转换；没有上游时间为 null/UNKNOWN_SOURCE_TIME，HTTP Date 和本地接收时间不能替代。统计字段不能借用盘口同步时间。`syncStatus` 独立保存为 `sourceSyncStatus`；market 的查询时 latest block 与 book 的 fully processed block 语义不同，均不能证明 volume/OI 自身更新时间，统计 `sourceObservedAt` 仍可为 UNKNOWN。时间秒单位来自实测，按量级校验，不盲信任字符串。
- 缺字段/格式不合法/分页不全/截断/失败/过期各自给 reason；已知数值可保留并标 partial/stale，但不可作为完整当前证据。UNKNOWN 不等于 0，不等于市场无流动性。

## 数量、APR 与深度消费规则

官方当前 schema 核验的单位：book `sz` 是 18 位定点 YU 原始整数，显示 YU = raw / 1e18；market `data.volume24h` 与 `data.notionalOI` 已是未缩放 YU 数值，不再除 1e18。YU 表示以该 market 抵押资产为单位的计息名义本金；数量上的抵押单位换算不等于持有同量现金 collateral，不等于保证金或 YU 当前市值。项目 `BorosMarketOrderRequest.size` 及持仓 `sizeToken` 沿用这类抵押资产单位名义数量；不可借用永续 ETH 数量或乘以剩余期限再次转换。官方依据及资产映射见来源核验。

保留 BigInt 字符串，不直接转 JS Number 后用于精确相等、去重或回放；页面数值是显示近似而非执行参数。`/v1/assets?isCollateral=true` 用于 tokenId 对照 collateral 元信息/价格；真实 ERC20 decimals 与 YU 的固定 18-decimals 属于不同量纲，不能用 ERC20 decimals 缩放 book sz。

- 盘口 APR：`aggregateIndex * tickSize`，可以为负或零。`tickSize=0.0001` 对应 1 APR bp。此 aggregateIndex 不是链上 `tick` 的指数变换，不套用 `1.00005 ** tick - 1`。
- APR 内部 fraction；`APR percent=100*fraction`，`Spread pp=100*(bestAsk-bestBid)`，`Spread APR bp=10000*(bestAsk-bestBid)`。先确认两侧有效；best/Spread 由 1 bp 聚合桶计算，标注 `bookTickSize` 和“聚合盘口 APR/Spread”，不等于未经桶化的精确 bestBid/bestAsk。market 数据若含原始 bestBid/bestAsk，须保留自己的来源/时间，不能与 book 桶值拼接计算。交叉盘口保留异常，不能 abs()；不用 `/mid` 计算现货相对 spread，特别不能因 mid=0 除零。
- 接口 long 是挂单的 long 方，供 taker short（receive fixed）成交，作为 bids 降序；short 是挂单 short 方，供 taker long（pay fixed）成交，作为 asks 升序。原始响应顺序即使已有保证，消费者仍验证并排序，保留两侧独立状态。
- 第一阶段默认 `includeAmm=false`；AMM 可选合并是另一个 scope，不可混入 pure book 深度或按 `true-false` 差推算完整 AMM 深度，因为两次响应都可能裁剪且时刻不同。
- 首期只提供“可见双边深度”：对已返回有效档求和，报告档位数、最远 APR、服务端 best-50 限制、客户端舍弃与截断风险。没有继续翻页参数，不以 50 档之和证明全书总深度。
- 诊断窗口分别距本侧 best：asks 的 `[bestAsk, bestAsk+w]`、bids 的 `[bestBid-w, bestBid]`，w 为 10/25/50 APR bp（0.001/0.0025/0.005），包含端点。book 尾部仍在窗口且达到服务 cap 时，该窗口深度仅下界；尾部已越过窗口且返回有效排序/完整聚合时，可在官方 best-first/top-50 契约下证明该聚合窗口未被 cap 裁掉，但仍注明桶化与源时间限制；任何无效/舍弃档都会使窗口 partial。少于 cap 不凭数量 alone 宣称全书 complete。
- 完整且有效空数组的一侧，其“响应可见深度”为 0；best APR 为 UNKNOWN，缺任一有效 best 则 mid/Spread UNKNOWN。请求失败或 ia/sz 不配对的一侧深度 UNKNOWN；丢失档位不能当空书。
- `data.volume24h` 的当前官方 schema 为 rolling 24h 的 `sum(abs(trade.size))`，以 YU 表示市场全量，不是账户成交、成交利息或 USD turnover。滚动窗口确切截止/统计更新时间仍需字段级证据；不能由响应接收时间倒推出统计截止。
- `data.notionalOI` 官方 schema 明确为 one-sided OI（`getOI()/2`），已缩放 YU；这是存量，不是成交量或深度。首期规范字段命名 `notionalOiOneSidedYu`，展示标签明确“单边 OI”。
- 截图 Notional OI 数值约为当前 API 单边 OI 两倍，四个可匹配 market 与 volume 精度对照支持这个差异；官网自身 OI 公式未核验，不断言其计数规则。可以展示明确标注推导值的 `2 * oneSidedOiYu`，但不得标成已获取的官网字段或无标签 Notional OI；#03 保留 native 单边值与口径，#05 不以两者相等验收。
- 不得从账户 transactions/fills/资金费结算日志生成 market-wide volume，也不按逐侧挂单总量生成 OI。

## 截图人工对照（非实时证据）

来源：用户于本聊提供的 Boros 官网 market picker 截图；截图实际采集日期/时区 UNKNOWN，浏览器 URL 指向 market 197 不表示弹窗全部行都属于 197。图标 venue 只作视觉参考，最终以官方 platformId 匹配。

| 截图分组 | collateral | 到期日期 | 24h Volume（已舍入） | Notional OI（已舍入） |
| --- | --- | --- | --- | --- |
| ETHUSDC，第一组（Hyperliquid 图标） | ETH | 2026-10-30 | 1,114.52 ETH | 15,031.9 ETH |
| 同组 | ETH | 2026-12-25 | 69 ETH | 4,541.79 ETH |
| 同组 | ETH | 2026-11-27 | 45.293 ETH | 2,427.87 ETH |
| ETHUSDC，第二组（图标；官方 metadata 对照为 Lighter） | ETH | 2026-10-30 | 929.164 ETH | 1,524.53 ETH |
| 同组 | ETH | 2026-11-27 | 6.03148 ETH | 554.298 ETH |

下方 ETHUSDT/Binance 图标只看到标题，未看到统计行。截图没有 best bid/ask、Spread 或深度，不能补值；Underlying APR/Implied APR 也不是 Spread。后续官网对照须记录各自读取时刻、market ID、platform/symbol/collateral/到期、单位及舍入误差；不要求新旧时刻数值相同。

## #03–05 交接验收

- #03：读取已核验的公开 GET；保留 raw/source/coverage；严格验证分页、身份、数量、单边与字段失败；把缺失原因交给消费者。不得扩展成 market-trades 历史全量采集来补未经验证的 volume 口径。
- #04：按本契约公式输出 Spread 与各侧可见/窗口深度；边界验证负/零 APR、端点、截断、单边、异常交叉、单位和精度。未证实的换算、统计截止/更新时间保持 UNKNOWN；rolling 24h 定义已由当前官方 schema 证实。
- #05：分别显示 volume/OI/book 的时间与单位及限制；不输出原子展期 ready、可成交最大量或保证金结论。API→指标→页面和真实浏览器验收留到该票。
- 已知不可验证语义不是猜测的许可；下游优先展示可证实原生指标，未知字段继续 UNKNOWN，来源待补的原因不能藏在 tooltip 之外的假成功状态中。
