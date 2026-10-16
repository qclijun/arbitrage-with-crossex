# 盘口新鲜度与未对冲暴露：研究证据

日期：2026-10-16；分支：`research/latency-freshness`。研究范围是指标和执行路径的决策依据，不是实现或安全阈值批准。全程未调用交易写接口、未重启服务、未操作 SQLite。

## 结论

当前最值得分开的两个指标是：**本地确认 Maker 成交后，到登记/发送对冲的响应时间**，和**实际 Maker 成交到实际对冲成交的经济暴露时间**。前者能直接检验程序减少无关等待的效果；后者包含轮询发现、转发、撮合等环节，跨交易所时钟差尚未测出，不能把两个成交时间相减当作无偏真值。[实盘审查](../../four-leg-maker-requote/live-validation-2026-10-16.md)

`tickPair` 确实在 `OPENING/best` 且已有对冲义务时，先 await Maker `bestA`，再 await 对冲腿 `refB`。但是 `needBest` 还驱动盘口故障的开始/恢复事实，不能只删一次读取而让旧状态被误清除。减少等待的实施方案须明确哪些 tick 不需要 Maker 追价，以及这些 tick 的 outage 标记如何保持；原有取消优先、未知冻结、最小名义金额、dust、退避和中途指令复核不可消失。[loop.ts:591-715](../../../src/engine/loop.ts)

## 时间字段的来源与边界

| 字段 | 核验语义 | 能证明什么 / 不能证明什么 |
|---|---|---|
| Gate REST `current` | 响应数据生成时间；官方示例为秒含小数 | 与本地接收差包含跨钟偏差及传输，不能叫纯网络延迟 |
| Gate REST `update` | 盘口发生变化时间；同为秒含小数 | 同源 `current-update` 可区分静止盘口与响应生成；很久未变化不自动等同故障 |
| Gate `id`（`with_id=true`） | 每次盘口变化递增的 ID | 可辅助识别重复版本；不提供跨交易所时间同步 |
| HL REST `l2Book.time` | 响应盘口时间戳，毫秒 | 官方未在此字段说明中承诺具体采样周期、传输时延或相对本机的时钟误差 |
| HL WS `WsBook.time` / `WsBbo.time` | 消息有源时间；BBO 仅区块内 BBO 变化才推送 | 不能将“没有新 BBO 消息”直接认定断线；需要另有活性证据 |
| 当前 `NormalizedBook.ts` | `assemble()` 时本机 `Date.now()` | 仅表示本机组装时刻，不能当作交易所盘口更新时间 |

官方来源：[Gate REST futures order book](https://www.gate.com/docs/developers/apiv4/en/futures)、[HL info endpoint / L2 book snapshot](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)、[HL WS subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)。2026-10-16 使用 find-docs 的 Context7 官方条目查询 Gate、HL；通过 agent-reach 的 Web/Jina 后端另读 HL 官方原文。WS 仅作为后续契约约束，不据此设计首期接入或承诺 WS 更快。

当前 Gate/HL 解析均只保留价格数量；`assemble()` 重写本地时间，`bestQuote/refPrice` 又返回单个价格字符串。1 秒缓存按本地请求开始时间记龄，best/touch/ref 使用不同键；缓存命中不表示源数据新鲜。结构索引对依赖的 `books.ts`、`venueGate.ts`、`loop.ts`、`decide.ts` 均为 `metadata_match/no_recorded_issue`，generation `2026-10-15T18:41:01Z`；仍为 best-effort，关键路径已读取源码核对。[books.ts:84-134](../../../src/core/estimate/books.ts)、[venueGate.ts:93-104,237-277](../../../src/engine/venueGate.ts)

## 建议保留的指标及证据链

| 指标 | 定义 | 验证边界 |
|---|---|---|
| 请求 RTT | 本地单调钟接收减发送 | 同机测量；不是行情年龄或单向网络延迟 |
| 源年龄表观值 | 本地墙钟决策/发送时刻减源更新时间 | 同时报告源时钟、单位、时钟偏移是否已校准；未来源时间或缺失字段不可归零 |
| 缓存驻留 | 本地决策时刻减上次本地接收/缓存写入 | 与源年龄分开，不把 TTL 机械加到 RTT |
| 决策至发送 | 单调钟 send-start 减 decision | 区分账本写入、排队与 SDK 执行；本地登记不等于网卡发送 |
| 下单往返 | 本地回执减 send-start | 不能等同 CrossEx→目标 venue 在途；createTime 不能单独拆分转发 |
| 本地对冲响应 | Maker 新累计成交确认→B 写前登记→B send-start→B 回执 | 同一单调时钟的可控分段；确认必须记录数量增量 |
| 真实未对冲暴露 | 按真实成交时间重建净基础币数量 E(t)，对各未被对冲的成交量算等待；报告峰值及积分 ∫|E(t)|dt | 跨 venue 时钟偏差未校准时应报告“成交时间表观差/误差未知”，不可宣称精确真值 |
| 结果指标 | POC 拒绝率、Maker 成交身份、超额对冲、残余 dust、数量归因 | 拒绝减少不代表风险下降；必须保持 POC，防止用吃单换取低拒绝 |

最少关联键：deal、leg、client ID、venue order ID、fill ID、源 venue/market、请求用途、tick/attempt、缓存键和命中、源/接收时间、数量增量、意图版本或前后字段、决策原因、unknown/reject/ok。只记必要元数据，排除签名、密钥及完整认证请求。

`project().unhedged=max(Afilled-Breserved,0)` 是**尚未预留的对冲义务**，B OPEN/PENDING 时预留整单数量；它不是实际净价格暴露。计算 E(t) 必须用已成交 `Bfilled`，不能把 B 的登记/预留当作风险已经消失。独立 Deal 的成交归因不能仅用全账户合并净持仓；须按 client/order/fill ID 去重、保留账户及合约单位。无可靠映射的其他手工单、多个 Deal、聚合成交分摊应标 UNKNOWN。[decide.ts:35-69](../../../src/engine/decide.ts)

## 当前实盘证据足够支持什么

本笔 0.410 ETH Maker 两笔成交仅相隔 1 ms；本地确认全部成交后 321 ms 登记 B。Gate 最后 Maker 成交与 HL 对冲成交时间表观差为 2.295 秒；交易所间时钟偏差没有独立测量，精确经济暴露时长仍未知。未记录本地实际 send-start，因此不能把登记→交易所 createTime 全部当作网络耗时。[实盘审查时间线](../../four-leg-maker-requote/live-validation-2026-10-16.md)

独立短时盘口样本（每项 6 次）Gate RTT 中位 134 ms、HL 157.5 ms；Gate 接收减 current 中位 54 ms，HL 接收减 time 中位 630 ms；它们不属于原成交时刻。NTP synchronized 不能证明交易所间偏移为零；HTTP Date 粒度及响应生成位置也不足以精确校准。原交易每次 POC 拒绝的源盘口年龄不可还原。[测速报告](../../four-leg-maker-requote/book-latency-2026-10-16.md)、原始临时证据 `/tmp/requote-book-latency-probe.json`（非持久归档，丢失后不可假定仍存在）。

## 对冲读取可否减少：约束与选择

1. **可审查跳过 Maker bestA 的条件**：本 tick 有可提交 B 义务且最终决策不使用 Maker 追价/下新 A 单；不过取消、期限转换、冻结、退避、dust 及 outage 事实需逐条保持。不能把 `unhedged>0` 直接当作必然发送 B：`sizeFor` 可能返回 0/null，模式也可能要求先取消 Maker。[loop.ts:591-715](../../../src/engine/loop.ts)、[decide.ts:215-330](../../../src/engine/decide.ts)
2. **B refPrice 的必要性**：当前用于 minNotional，不是 B 市价限价带。minNotional>0 且没有可用参考价时返回 null，禁止凭猜测 sizing；数量向下取整，dust 不计为缺价失败。跳过 ref 仅适用于当前规则明示无需它的分支；不得用 '0' 哨兵绕过真实校验。[decide.ts:78-95](../../../src/engine/decide.ts)、[loop.ts:650-680](../../../src/engine/loop.ts)
3. **只读可并发的前提**：已冻结相同意图和投影；所有结果携带独立状态/时间；有界超时与失败隔离；只有实际依赖的结果阻塞最终动作。如果 `Promise.all` 仍等慢 bestA，B 响应不会因此提前。所有交易写入仍在单写者 ACT、每 tick 至多一次，保留先写账本后 wire。
4. **中途 Stop/Convert/改价**：await 后重读意图，变化则整个旧上下文失效并等下一 tick；不能混用旧 mode 的 fetch 谓词和新意图。unknown/PENDING/quarantine 冻结 placement，只允许既有取消规则绕过。STOPPING/HALTED/CONVERTING 的 Maker 取消优先不得被所谓紧急读取改写。[loop.ts:682-717](../../../src/engine/loop.ts)、[decide.ts:215-310](../../../src/engine/decide.ts)

## 必须留给人的风险政策

- 新增获取/重报价遇到源超龄、缺时间、单边/交叉盘口或断线，应怎样停止新增风险、何时取消已有 Maker、何时恢复；源更新时间长期不变但响应/活性正常如何判定？当前仅双边价格有效性并不构成真实源新鲜度证明。
- 已有成交对冲义务遇到同样故障，是等待合规新参考价、使用特定可验证备用源，还是允许显式应急策略？等待可能延长暴露，接受旧价可能误判 minNotional；这项权衡不能由缓存失败时偷偷返回旧值决定。
- 允许哪些源时钟偏移/未知状态，如何从同机可验证响应改进过渡到跨 venue 暴露验收？阈值、统计窗口、长尾容忍、应急限额本研究均不代定。
- 全局共享单写者中的其他 Deal、订单查询慢请求是否纳入首期优化？本研究识别其可能阻塞，不扩展为调度器重构。

## 可交给实现阶段的离线反例

覆盖：bestA 慢而 B ref 快；B ref 缺失/超龄；minNotional 附近数量且禁止向上凑；零碎部分成交与跨 lot dust；cancel 在途新增成交；unknown/quarantine；Hedge backoff；Stop/Convert/固定价在 await 中提交；旧 outage 标记与恢复；跨币种/同账户多 Deal 的 fill 去重；本地墙钟跳变、源时间未来值/单位混淆；B 已预留但未成交时仍报告实际暴露。验收以保持决策/订单数/持久化不变量及明确分段计时为主；本研究不承诺毫秒阈值，也没有用新增实盘验证这些分支。
