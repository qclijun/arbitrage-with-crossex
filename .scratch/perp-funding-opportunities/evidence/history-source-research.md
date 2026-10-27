# 07 生产资金费历史来源研究

取证日期：2026-10-27。范围：八个候选场所的**公开官方文档**，不是对每个 CrossEx live 合约的生产数据审计；本轮未调用场所接口、未使用账户凭据，live 合约清单与接口延迟均未实测。下表分别判断“历史来源存在”和“逐笔已结算语义”；verified 仅指文档证明对应能力，**不等于具体合约窗口 complete**。unknown 为证据不足，unsupported 只用于已证明没有合用能力的对象；本次未把任何场所整体判为 unsupported。[完整性契约](../history-and-eligibility.md)仍决定实际排名和下单资格。

## 能力矩阵

| 场所 | 历史来源 / 逐笔已结算语义 | 历史周期及上市依据 | 分页、保留、鉴权及主要缺口 |
|---|---|---|---|
| BINANCE | [USDⓈ-M `GET /fapi/v1/fundingRate`](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data) 返回 `symbol, fundingTime, fundingRate`，verified；与 `premiumIndex` 的当前/下一期数据分开。`rateType=Special` 可能与常规事件同时间出现，唯一键不能只用时间。 | `fundingInfo` 给**当前**调整后 `fundingIntervalHours`；`exchangeInfo` 有 `onboardDate`。历史生效时刻/默认周期变更日志的逐合约机器证明 unknown。 | `startTime/endTime` 双端含，升序、上限 1000；超额只返前 1000，需续页。`fundingRate` 与 `fundingInfo` 共用 500/5min/IP；公开 market data。365 天若逐小时约 9 页/合约；历史周期证据仍缺。 |
| ASTER | [官方 V3 文档 `GET /fapi/v3/fundingRate`](https://raw.githubusercontent.com/asterdex/api-docs/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md) 给 `fundingTime, fundingRate`，verified；当前 `premiumIndex` 不能替代历史。 | V3 `fundingInfo` 有当前 `fundingIntervalHours`，`exchangeInfo` 可用于产品识别；历史周期生效时间及上市前完整性 unknown。 | 双端含、升序、上限 1000、权重 1，公开接口；大窗口需按最后事件推进。官方推荐 V3，旧 V1 不作为新集成依据。 |
| OKX | [官方 `GET /api/v5/public/funding-rate-history`](https://app.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate-history) 明列 `fundingRate` **预测**与 `realizedRate` **实际**、`fundingTime`；必须取后者，verified。 | 官方明确有 8h 到 6/4/2/1h 变化；历史返回未给逐段 `nextFundingTime`，仅靠相邻事件间距不能证明缺期或变更。上市与历史周期逐段依据 unknown。 | 最多近三个月、每页最多 400；`after` 取更旧、`before` 取更新；10 次/2 秒/IP+合约。180/365 天通过此端点 **unsupported**，可另研究官方历史市场数据批量端点；公开。 |
| BYBIT | [官方 `GET /v5/market/funding/history`](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate) 明称最后一笔为已结算期，`fundingRateTimestamp`+`fundingRate`，verified。 | [instruments-info](https://bybit-exchange.github.io/docs/v5/market/instrument) 给**当前** `fundingInterval`；历史变更、上币前界限 unknown。 | 每次最多 200；只传 `startTime` 报错，需给 `endTime` 或双边；无游标，用时间倒退且检查边界。保留期未见官方保证；[IP 默认 600/5s](https://bybit-exchange.github.io/docs/v5/rate-limit)，公开。 |
| GATE | [官方 SDK 文档](https://raw.githubusercontent.com/gate/gateapi-python/master/docs/FuturesApi.md) `GET /futures/{settle}/funding_rate` 返回 [`t` 秒、`r` 字符串](https://raw.githubusercontent.com/gate/gateapi-python/master/docs/FundingRateRecord.md)，历史来源 verified；逐笔结算终态 unknown，需生产对照。 | 合约接口可查当前合约；历史周期变更及精确上市起点 unknown。 | `contract, from, to, limit`，默认 100，公开；最大 limit、截断/边界规则及保留期 unknown。[批量 `POST /funding_rates`](https://raw.githubusercontent.com/gate/gateapi-python/master/docs/FuturesApi.md) 仅见 contracts 列表，时间范围/覆盖语义 unknown，不能据此当全量历史。 |
| HYPERLIQUID | [官方 `info` 的 `fundingHistory`](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals) 按 `coin,startTime,endTime` 返回 `time,fundingRate`；与 `predictedFundings` 明确分开，verified。 | [官方资金费说明](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding) 每小时结算；新币上线时间的可核实来源、历史例外 unknown。 | 时间双端含；返回条数上限及截断/分页承诺未见，不能以单次响应认定完整。[info 限流](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) 基础权重 20，另按每 20 条增权，IP 1200 权重/分钟。 |
| KRAKEN | [官方 CSV 导出](https://support.kraken.com/articles/export-historical-funding-rates) 称所有可用衍生品市场自上市起历史费率，历史下载来源 verified；CSV 逐笔结算字段 unknown；[analytics `funding`](https://docs.kraken.com/api/docs/futures-api/charts/market-analytics) 是时间桶，不证明逐笔结算。 | CSV 内字段、历史周期变更、精确上市与 CSV 更新频率均 unknown，需下载并核验 schema、末条时效。 | 自动增量接口、分页、15 分钟可用性和鉴权 unknown；不能把静态 CSV 宣称实时服务，也不能因未找到接口判整所 unsupported。 |
| LIGHTER | [官方 SDK `GET /api/v1/fundings`](https://raw.githubusercontent.com/elliottech/lighter-python/main/docs/CandlestickApi.md) 以 `market_id,resolution,start/end,count_back` 返回 [`timestamp,rate,direction,value`](https://raw.githubusercontent.com/elliottech/lighter-python/main/docs/Funding.md)，历史来源 verified；逐条最终结算语义 unknown，需核验。跨所 `funding-rates` 是当前比较流，不能代替。 | 官方字段未给历史周期规则、生效时刻或上市时间；unknown。 | 每次最多 750，公开，无分页完成标志；需切连续时间片并核验端点边界、保留期。限流数字 unknown。 |

08 实施补充核验（2026-10-27）：[Binance 官方 fundingRate 响应说明](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)和[2026-07-23 更新日志](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/change-log)明确 `Special` 是股票分红产生的**额外**资金费率。相同结算时间的 `Regular` 与 `Special` 是不同经济类型，分别去重后均计入总费率；同类型同事件的冲突仍须隔离。此结论不改变历史周期、分页及上市证据仍需逐合约证明的限制。

[Hyperliquid 官方 `fundingHistory` 示例](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals#retrieve-historical-funding-rates)的 `time` 比 UTC 整点晚 76 毫秒。08 的归一化要求对这类原始时间提供可核验的结算整点映射依据；09 未证明前保持 UNKNOWN，不能直接把原始毫秒时间当作周期结算边界。

## 覆盖证明与失败用例

1. 从 CrossEx **当轮 live 合约**映射精确场所 contract/market ID；拉取官方上市时间与历史规则分段，并持久保存来源版本及读取时间。文档只给当前周期时，8h→4h 边界两侧不能仅靠“行数看似正确”证明覆盖，状态为 unknown；可用官方带生效时间公告或连续、独立结算账证明分段。没有证据时不倒推周期。
2. 按 `(start,cutoff]` 取窗口，按场所官方事件键加经济类型去重；同键费率/周期冲突保留两版并置 unknown。Binance `Special` 需单独定义经济事件，不可与 Regular 覆盖。OKX 用 `realizedRate`，各场所必须排除预测值、时间桶和当前 bulk feed。
3. 每页记录请求参数、响应首末时间、数量、游标与终止理由；满页继续读到已证明越过窗口起点或明确无更多。模拟第 2 页 429/超时、页重叠、尾页未返回：保留部分事件但覆盖 partial/unknown，绝不按已有累计排名；下轮从安全边界重取并比对。HL/Lighter 等无明确完整性标志时，即使单次返回少于上限也只能在官方时间切片/行为得到验证后判定。
4. 新币若上市 10 天，30/90 天窗口上市前无结算不是零；30 天 unknown 或 partial，不排名。若**上市和规则均有证据**且最近 7 天逐期齐全，7 天可 complete。若上市时间来源不可靠，7 天也 unknown。
5. 逐来源留原始哈希、抓取时间和事件版本；重抓同事件不同值视冲突，不静默覆写。官方文档普遍未承诺历史数据不可修订，修订流程及权威版本选择均 unknown。

## 15 分钟采集预算：待 09 实测的保守上界

设 `N_v` 为当轮 CrossEx live 合约数、`P_v` 为每合约为选定最长窗口实际需要的页数。全量冷启动请求下界至少 `Σ N_v×P_v`，另加合约/规则查询；15 分钟是否可满足取决于实时 N、周期、接口保留、响应耗时和共享 IP 负载，**本轮无法证明全市场均可完成**。例如逐小时 365 天有 8760 期：1000/页至少 9 页，750/页至少 12 页，200/页至少 44 页；OKX 公开历史端点仅三个月，180/365 天不可能由它补齐。

建议 09 以每轮**全局最多 240 个请求、每场所最多 40 个、并发每场所 2、单请求 5 秒超时、最多 1 次带抖动重试、硬截止 12 分钟**作离线模拟的初始预算；剩余 3 分钟用于核验/发布。这是内部保护阈值，**不是交易所承诺的容量**。更低的场所限额与响应头优先：Binance 共享 500/5min/IP，OKX 10/2s/IP+合约，Bybit 默认 IP 600/5s，HL 1200 权重/min 且响应长度增权。Gate/Lighter/Kraken 的适用数字仍 unknown，未实测前按更低吞吐且不向账户 API 抢预算。429、权重不足、超时、页数上限或截止时停止该腿，记录预算耗尽/失败，旧快照不刷新 `verifiedAt`；其余场所继续。页面仅读缓存。

## 待证实字段与后续承接

- 所有场所：每个 live 合约的精确上市/退市与历史周期**生效时间**、逐窗口真实保留起点、修订和冲突的权威语义；多数官方历史响应没有不可变事件 ID，需复合键及冲突隔离。
- OKX：另查官方历史市场数据批量端点能否给超过三个月的逐结算实际率；不能把桶数据算作原始事件。Gate：批量端点时间范围/返回约束。Kraken：CSV schema、更新时间及是否存在可用于增量刷新的官方逐结算接口。Lighter：`fundings` 每条的结算终态与时间单位/上限行为。HL：响应截断行为与新币起始证据。
- 09 在只读公开样本上实测每场所两种周期、一个新币及跨页窗口，记录请求/延迟/429；再核对 CrossEx live 合约数量。无法证明的组合保持 unknown；可按场所拆票，不降低 01 的完整性门槛。
