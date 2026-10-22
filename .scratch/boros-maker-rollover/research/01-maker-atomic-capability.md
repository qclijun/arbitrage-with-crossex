# Boros Maker 展期：协议能力与原子性

研究日期：2026-10-22（Asia/Taipei）。范围：第一方公开文档及已完成的本地代码核实；未访问账户、未运行交易或修改账户。本报告解决能力研究，不决定采用门槛。

## 结论

1. **协议明确支持 passive Maker。** ALO 是 post-only；会立即成交时回滚。当前项目展期端口只接入 IOC/FOK，不代表协议不支持 ALO。[S1、S7；访问 2026-10-22]
2. **普通多市场限价单不能据批量建单推定未来成交联动。** 原子提交可以让订单一起进入订单簿；此后某一市场的单腿可先成交。官方明确普通两 Funding Market 持仓可发生单腿限价成交。未找到“未来四腿按同量原子成交”的原生 Maker rollover/contingent 契约，记为 **UNKNOWN**，不声称协议绝对不可能。[S2、S3、S5；访问 2026-10-22]
3. **原生 Spread 缩减同期限跨交易所腿数，不能自动解决跨到期日展期。** 一张 Spread 订单是一仓，对应同一资产在 A、B 交易所资金费之差；旧 Spread 平仓与新 Spread 开仓仍是两个市场订单。未找到这两单未来被动成交联动保证，亦为 **UNKNOWN**。[S5；访问 2026-10-22；后半句为据市场定义作出的推论]
4. **尚不能据公开能力确认存在满足本地图资金费缺口/过覆盖边界的 Maker 展期路径。** 普通独立 ALO 是可建单路径，但每次可能成交组合必须先过实际边界；具体边界未给出，不能把它解释成零，也不能擅自放宽。研究不足以批准实施。[S1、S5及本地图已确认约束；2026-10-22]

## 能力矩阵

| 能力 | 官方协议/SDK 证据 | 当前项目 | 判定 |
| --- | --- | --- | --- |
| 明确不立即吃单 | ALO/post-only；cross book/AMM 则回滚；SOFT_ALO 会跳过可立即成交部分 | 展期 TIF 仅 IOC/FOK | 协议 YES；当前 NO |
| 普通 GTC 限价 | 单笔可立即吃 book/AMM，剩余才挂单；bulk 不匹配 AMM | rate 是最差 APR 边界 | GTC/有 rate 都不足以保证 Maker |
| 多市场一起建单、撤改单 | Router bulkOrders 支持多市场及先撤后挂；SDK bulkPlaceOrders 描述单次上链 | 当前四腿 FOK 同批、requireSuccess=true | 可复用批次概念，需新接入及确认实际部署契约 |
| 多市场未来成交同量绑定 | 已披露普通两市场单腿可成交；未见 rollover contingent 契约 | 没有 resting Maker 展期 | UNKNOWN；不能用批次原子性替代 |
| 原生 Spread 单笔执行 | 同期限两交易所资金费差是一仓、一单 | 当前 spread 一词还可能指两 Funding Market 组合 | 原生产品 YES；不能混名推定已接入 |
| resting 部分成交/单笔撤单可观察 | orderId、remaining size、状态、活动单、历史交易及链上读 | 有 bounded 查询、非完整 Maker 生命周期 | 原料存在；完整恢复尚未验证 |

来源：上表前三行 S1/S2/S3/S7；第四、五行 S5；末行 S1/S4/S6/S7；当前项目均为 [代码核实](../evidence/code-discovery.md)。全部访问/核实日期 2026-10-22。

## passive 与原子性的精确定义

- **Passive**：用 ALO 在执行时由协议拒绝 crossing，比客户端下单前看一眼买卖价更强。普通 GTC 即使下单时看起来不 crossing，也不能据此保证实际入链时仍是 Maker。SOFT_ALO 可能不建立原请求的全部数量，不适合作为“请求量全部挂出”的证据。[S1；2026-10-22]
- **FOK**：要求立即全量成交，否则回滚；这是即时流动性路径，不是排队等待的 Maker 路径。IOC 允许部分成交、取消剩余，不能替代 FOK 的全量保证。[S1；2026-10-22]
- **建单原子性**：同一操作内要么建立全部指定订单，要么失败。**未来成交原子性**：等待后每次成交也必须将关联腿按约定数量一起改变。第一项不推出第二项。[S2/S3 的批次描述与 S5 单腿成交例；推论，2026-10-22]
- 官方 best-practices 把 `requireSuccess=true` 描述为所有 calldata 一起成功或回滚；API 页更具体描述为整批预模拟，失败则不向链上发送。SDK 又称 bulkPlaceOrders 是一次上链、一个 nonce。**预模拟本身不构成执行期跨 calldata 原子性的证明**；当前部署版本、calldata 包装与链上回滚范围仍需确认。即使采用其中最强的建单原子性描述，也没有未来 resting fills 的全成契约。[S2/S3/S7；2026-10-22]
- Router 的 ConditionalModule 是 agent 签名、permissioned validator 触发执行的单市场条件单；公开参数有 marketId、side、size、tif、reduceOnly 等，但该描述没有给出跨市场四腿 Maker 联动成交保证。不能拿“conditional”字样补足该缺口。[S3；2026-10-22]

## 普通市场与 Spread：可行路径及反例

| 候选 | 已证实能力 | 反例/尚缺保证 |
| --- | --- | --- |
| 两旧 Funding legs + 两新 Funding legs 都挂 ALO | 允许多市场 post-only 建单 | 旧 A 先平、其余三单不动；或新 A 先开、旧仓不变。会改变某一资金费覆盖，不必同时产生永续价格净敞口。是否越界须逐腿核算，不能只看总名义数量 |
| 原生旧 Spread 平仓 + 新 Spread 开仓都挂 ALO | 每个 Spread 内 A−B 是一仓 | 旧 Spread 先平会减少覆盖；新 Spread 先开会增加重叠。单笔 Spread 的合成属性不跨到期日 |
| 一腿 Maker 成交后，用另一腿 Taker 补齐 | 每个单独交易原语存在 | 观察、提交、上链之间仍有覆盖变化；除非现有边界明确容纳全过程，否则不能声称合规 |
| 分小片串行 Maker 或原子 ALO 建单 | 能控制请求规模、一起建单 | 小片仍可单腿先成交；必须证明每种部分成交状态都在既定边界内，不能自行设片大小/等待阈值 |
| 原生未来四腿绑定 Maker rollover | 本轮未找到公开契约 | UNKNOWN；需要官方具体接口/合约及可验证的逐次成交语义 |
| 当前四腿 FOK Taker | 当前实现同批、逐腿全量核验、unknown 不算成功 | 作为当前后备路径保留；仍按现有运行及风险规则使用，本研究不授权交易 |

前四行是根据 S1/S3/S5 市场与订单语义推导的可达反例，非实盘测试结果；最后一行见代码核实。2026-10-22。

## 部分成交、撤单、unknown 与恢复

- 官方 `getOrder()` 对未完全成交订单返回**剩余未成交量**。完全成交后的 size 不能简单当累计成交：它可能是最后一次完全成交前剩余量，排除了更早部分成交。必须保留原请求并对照历史交易/事件及持仓。[S4；2026-10-22]
- 状态有 NOT_EXIST、OPEN、PENDING_SETTLE、PURGED。NOT_EXIST 既可能从未放置，也可能已撤；PENDING_SETTLE 表示已成交；PURGED 是被保护机制清理。单独“不在活动单里”不能证明从未成交。[S1/S4；2026-10-22]
- Router 支持单笔 IDs 或 cancelAll；bulk 的 isStrict=true 遇不存在订单回滚，false 则跳过。因此“撤单请求成功”也不能推出此前零成交。需在提交最终结果基础上读取剩余挂单及已成交/持仓，再计算可安全回退数量；撤单前先成交的竞态仍存在。[S3/S4；最后一句为推论，2026-10-22]
- REST 的 `syncStatus` 提供 blockNumber/timestamp；按更新时间分页可能漏/重，应使用按不可变 placedEventIndex 的 all-limit-orders 稳定分页同步。SDK 的 getActiveOrdersFromContract 读 Explorer，可避免索引延迟。未知状态不得降为零成交；具体链重组确认深度、cancel 最终性 SLA 和事件字段的部署版 schema 在本轮未审计，**UNKNOWN**。[S6/S7；2026-10-22]
- `skipReceipt=true` 只立即返回 hash；false 等待交易进块并带 status/error。官方恢复建议按 agent+nonce 查询 trace；记录保存 24 小时，并说明 bot 拒绝不大于已见最大 nonce 的 calldata，含模拟失败 nonce。该去重依赖复用原签名/nonce，**不等于新 nonce 重试幂等**，也不等于任意 clientOrderId 去重。跨版本、跨提交端点、24 小时后的完整恢复契约未验证。[S2/S6；2026-10-22]
- 当前独立 cancel 仅检查提交响应，没有已核实的最终撤净轮询；unknown 处理为有限 txHash 查询与约 10 分钟进程内 memo。不能承诺跨重启 Maker 生命周期恢复。持久登记、持续查证、撤净后回退等仍需实施规格。[代码核实](../evidence/code-discovery.md)，2026-10-22。

## 可复用能力与下一步证据门槛

当前四腿批次参数构建、旧/新精确 size、roll simulation、逐腿结果/shortfall 核对、unknown 不视为成功，可作为实施起点；不可直接复用为 ALO 挂单队列、取消握手或跨重启恢复。[代码核实，2026-10-22]

进入采用决策前需补齐：

1. 已确认的资金费缺口/过覆盖边界的数值、作用腿和时间范围；按旧/新、部分/撤单竞态枚举全过程。不能只约束最终持仓。
2. 若声称未来原子 Maker：官方给出部署合约/接口、跨到期日绑定数量及部分成交/取消语义。否则只按独立订单模型评估。
3. 若考虑原生 Spread：核对资产、A/B 顺序、到期日、结算节奏与现有持仓匹配；可用市场不是任意组合。[S5]
4. 实施前确认当前 API/SDK 版本、实际批次链上包装、ALO tick/精度与 rate bounds、取消和事件 schema；此报告不提供可直接下单的参数。
5. 费用、排队、机会成本、可执行净节省交由费用研究；本票不选择等待时限、片大小、风险上限或最低收益。

本轮研究已完成；能力 UNKNOWN 仍是后续决策的约束，不能因工单 resolved 就当作能力获证。

## 来源账本与复核范围

下列均为 Pendle 第一方文档，访问日期统一为 **2026-10-22**；页面未提供固定版本/发布日期。引用结论定位到标题；后续实施应重新核对部署版本。

- **S1** [Custom Types](https://docs.pendle.finance/boros-dev/Contracts/CustomTypes#timeinforce)：TimeInForce、OrderStatus、MarketStatus。
- **S2** [Boros API Best Practices](https://docs.pendle.finance/boros-dev/Backend/best-practices)：Bulk Order Placement、Market Maker Order Flow、requireSuccess、Recovering from Network Errors (Trace + Nonce)。
- **S3** [Router Integration Guide](https://docs.pendle.finance/boros-dev/Contracts/Router)：Place Single Order、Bulk Orders、Cancel Orders、Conditional Orders。
- **S4** [Market View Functions](https://docs.pendle.finance/boros-dev/Contracts/Market#getorder)：getAllOpenOrders、getOrder、Position and Risk；注意 NoSettle 返回未结算数据。
- **S5** [Spread Markets](https://docs.pendle.finance/boros-docs/about-boros/spread-markets)：Spread Markets vs Two Funding Market Positions、Long and Short、Settlement。
- **S6** [API](https://docs.pendle.finance/boros-dev/Backend/api)：Placing an Order、skipReceipt、Calldata and requireSuccess、V2 Cursor-Based Pagination。新 Open API mount 与旧 deprecated mount 有区别。
- **S7** [SDK (TypeScript)](https://docs.pendle.finance/boros-dev/Backend/sdk)：Method map、Place many orders、Read your active orders、迁移说明。
- 补充 [Order Book](https://docs.pendle.finance/boros-docs/boros-systems/orderbook)：orderbook/AMM、rate bounds、market modes；不要把 post-only 理解为所有行情下必然接单。
- 本地 [当前代码能力核实](../evidence/code-discovery.md)：已由代码 explorer 完成 graph/coverage 与源码复读；本研究未重复全仓结构探索。

取证方式：Context7 先解析 `/pendle-finance/sdk-boros-public`，再查 ALO/限价/批次；agent-reach Exa 定位、Jina Reader 读取官网。Context7 引用的公开 GitHub 仓库在 GitHub CLI 返回 404，因此其旧 SDK 摘要仅作导航，本报告关键结论以当前官网 S1–S7 为准；未据 404 推断项目停止支持。原始抓取临时文件 `/tmp/boros-{customtypes,best,router,market,spread,api,sdk-doc}.md` 非持久交付依赖；本文件保存结论、范围和直接来源。

## 阶段交接

本阶段目标是确认 Maker 展期协议能力及其原子边界，未修改交易代码、未提交或推送。已核实协议具有 ALO/post-only、多市场批量建单、订单余量/状态与链上读取工具；普通限价未来成交仍可能单腿独立，原生 Spread 仅把同期限两交易所资金费差合成一仓。未取得跨到期日四腿未来成交绑定契约，保持 UNKNOWN；requireSuccess 文档对预模拟与链上全回滚的描述需部署版补证。当前项目固定 FOK，缺完整撤净确认与跨重启 Maker 恢复。已完成官网交叉核对及本地代码报告对照，不适用程序测试。后续由采用决策票结合费用研究与用户已确认边界判断是否存在合规路径，未知能力未获证前不能批准实施；证据见本文件来源账本及 ../evidence/code-discovery.md。
