# 工单 03 现有执行链事实核查（2026-10-27，只读）

目标：核对复用边界，不替用户决定新产品门槛。未修改仓库、未运行实盘、未执行测试；本次仅静态证据核查。以下均刷新当前源码，不把旧摘要当当前保障。
核查工作区：`arbitrage-with-crossex-perp-funding-opportunities-docs`，分支`docs/perp-funding-opportunities`，基准`9dbab22`。以下是现有能力与缺口；产品决定以工单03的Answer为准。

## 1. Preview 与确认

- `web/src/trade/ExecuteControl.tsx:44,109-111,133-145,226-234,279-301,342`：所有非空 actions 均要求 preview；缺失、estimating、query error、任一 violations 会禁用。age 基于 **shown** preview 的 `shownAt`，阈值为 `ageMs > 10_000`（不是 >=），`useNow(1_000)` 每秒刷新 UI 判断，不能声称服务端有严格 10 秒验签/租约。
- `web/src/trade/usePreview.ts:35-76`：400ms debounce；调用者默认每 3 秒 refetch；placeholder/待 debounce 编辑通常 estimating。仅传入 tolerate 且认定价格漂移容许时，可保留旧 shown preview 并让新 preview 后台加载。新的 age 不会冒用正在加载结果的时间。
- `web/src/components/HoldToConfirmButton.tsx:40-102`：默认 800ms，40ms interval；primary pointer down 启动，pointer up/leave/cancel 或 disabled effect 取消；键盘 Enter/Space 和 click 不确认；到期调用最新 `confirmRef.current`。ExecuteControl 的 holdMs 仅为测试 hook。**hold 不会冻结报价，也不主动重新拉证据**。
- `ExecuteControl.tsx:290-325`：onConfirm 本身仅重查 actions/previews 存在与 !estimating；消费当前闭包的 preview，`finalizeActions(previews)` 后 decorate，再映射 POST /deals。没有确认时 await `/preview`、余额、费率或新书本的过程，也没有服务器 preview id/hash。disabled 是 UI 门槛，不能把它写成后端同样重验全部证据。
- `web/src/trade/finalize.ts:13-21`：open 的 qty 直接改为 preview qty，删 notional；open-limit 改为 preview price；close input 保留。`web/src/trade/deal.ts:38-56,78-90` 将 preview 的 qty/price/side 写入 DealRequest。

### 缺失余额或费率会不会放行

- 会。`ExecuteControl.tsx:244-252` marginBlocked 只在 preview 存在、margin.confident、available 有限、gateRequired>0 且超 available 才触发。余额 UNKNOWN/NaN 不会触发此门禁；warnings 不是 violations。
- `src/core/preview.ts:63-75` 找不到费率只加 warning，不加 violation；PairTicket `219-227` 缺任一 fees 默认 maker=long。不能说“无费率必须拒绝”已经实现。
- `src/core/preflight.ts:95-128,155-179`：服务端保证金预检明确 fail-open：单腿无法定价豁免该腿，账户读取异常/available非数字整个 margin check 返回；缺有效杠杆的腿被过滤，全部无法置信就返回。`181-193` 只有已知 required>available 才拒绝。这里用固定 TAKER_FEE_RESERVE，未验证用户展示的实际手续费率。
- PairTicket 自身另外以双方 leverageMax 已知才启用（`PairTicket.tsx:589-592`），但不能推导为通用 ExecuteControl 或直接 API 都 fail-closed。

### POST 后会重取哪些东西

- `src/server/routes/deals.ts:118-147,155-173` 与 `src/engine/create.ts:104-115,142-217,251-275,333-358`：重新检查支持币、live FUTURE rules、同币不同合约/方向、两腿 lot/min/max、maker price/最小名义、reduce-only 活仓与可减量；做上述 margin preflight；请求带 leverage 时会校验其上限。
- `deals.ts:130-139` account/positions 走 `TTL.live` cache；`src/server/cache.ts:28-30` 为 2,000ms。仅 account 在 transferMoving 时 forced fresh。因此“重新调用 preflight”不等于“确认时所有证据强制全新”。
- POST 不重跑 preview 费用/深度估算；maker 与 hedge 的后续价格由 engine 实际执行逻辑决定。不要把 preview 深度看作未来成交保证。

## 2. PairPrefill / 用户意图

- `web/src/trade/TradeFlow.tsx:16-49` 字段只有 base、longVenue、shortVenue、notionalUsd、可选 sizeBase、sizeUnit、mode、strategy='four-leg'，以及 provider 生成 nonce。没有 exact symbol、maker-leg 指定、每腿 leverage、手动 qty string、cost/slippage limit、opportunity id 或资格证据字段。
- `TradeFlow.tsx:210-224,236-252` 与 `PairTicket.tsx:122-186`：prefill 是内存 state/nonce 通道；先改 base/size/mode，再等本 base venues 数据非 placeholder，按 exchange 找首个 symbol。它不是精确交易合约身份协议。
- `PairTicket.tsx:136-142`：只有 sizeUnit=base 且 sizeBase 存在时填 base，否则转 USD；USD 用 `Math.max(1, Math.round(notionalUsd))`，会改变非整数美元/小于 1 美元意图。base 经过 `web/src/lib/fmt.ts:40-45` fieldValue 的 Number/toPrecision 默认8有效位格式化，故也不是任意精度 decimal string 通道。
- `PairTicket.tsx:158-165,206-227`：four-leg 默认 1800s，其他预填重设 300s；mode 不传则保留用户选择；杠杆自动取各 venue max；maker 按两种 maker+taker 费率组合自动选，缺费率选 long，平手选 long，没有用户固定 maker 腿。
- `src/core/orders.ts:83-120` qty 或 notional/ref 会按双方 coarser lot 向下取整，再校验双方 lot/min；`src/core/actions.ts:381-434` 显式 pairGroup 用共享 sizing 覆盖两腿 qty，变化只记 warning。不同输入 size 或混用 qty/notional 才 violation。`finalize.ts:13-21` 最终会提交该取整 qty。因此现有链会合法改变原始输入数量，03若要求“用户明确输入 qty 不静默变更/明确 maker/手动杠杆”，需要新增契约，不能宣称现成支持。
- `PairTicket.tsx:578-588` retry identity 包含两 symbols、size、unit、mode、fourLeg、makerLegPick、timeout、typed price 或 track；忽略动态 maker 跟价与临时 pairGroupId。需留意自动 maker 选择改变也会改变 intentKey。

## 3. id 去重、净仓/活动状态、unknown

- `src/server/routes/deals.ts:111-117`：只要 store.getPair(id) 已存在，立即 202 `{id,duplicate:true}`，不比较 payload、不重新做后续规则/杠杆/预检。网络丢失响应后，同 id 重送不会创建第二 deal；但同 id 不同 payload 也只返回原 id，编辑可能被丢弃。并非服务端提供 intent hash mismatch 拒绝。
- `ExecuteControl.tsx:203-224,290-296`：intentKey 变则恢复不同 id，确认前写 pending。`pendingBasket.ts:35-39,46-103` 是 intent→{id,ts} localStorage map，TTL 15 分钟、最多 20 条；`web/src/lib/storage.ts:3-18` 读写失败吞掉，持久化 best-effort。它不持久化完整动作、票据表单或 preview。重载后须重建同样 intentKey 才能找到原 id；TTL 过期/存储失败不能声称去重身份永久保留。
- `deals.ts:149-230`：route 在 createPair 之前直接 `setLeverage`，并不是 engine tick 消费 intent；前值读取失败记 0，恢复时跳过，恢复失败吞掉；多腿失败/后置 rebalance/transfer 拒绝时 best-effort 恢复。这是当前代码与 AGENTS 单 writer 原则的**既有差异**，本轮未修复，不能把新能力的执行保证建立在“现有 route 完全符合单 writer”上。
- 当前 inspected 创建链没有拒绝“开仓方向与既有净仓相反”的门禁。`src/core/actions.ts:214-215` 仅 close 才批量读 positions；`create.ts:251-275` 活仓硬校验只用于 reduce-only。相反，`preflight.ts:130-148` 在 one-way 模式按相反净仓 offset 减少 margin required，允许开单在共享净仓里先净掉旧仓。请求两腿反向 ≠ 相对账户现有净仓反向检查。
- inspected POST /deals 与 resolveDeal 无“同合约已有其他 active deal / venue order / 残余即拒绝”的独占门槛；它们没有相关遍历/查询，唯一 getPair 为本 id 去重。已有 engine 每票 pending/quarantine freeze 不能推导为账户级/合约级冲突门禁。结论仅覆盖此创建链，不是全仓库穷尽安全断言。
- 订单 unknown 可复用 **现有引擎正常 reconcile**：`src/engine/db.ts:500-526` 事务内先生成确定性 `t{hash(pairId)}{leg}{seq}` 并写 PENDING；`src/engine/loop.ts:391-435,468-470` commit 后 wire，UNKNOWN 留 PENDING；`286-345` 先按 venue/client id probe，读错保留 PENDING，权威 not-found 后等 ambiguity 窗口并做 history sweep，仅 covered absence 才 DEAD；未知无法证伪继续冻结。`105-148` 缩小 cum 或未知 venue status alert/quarantine，raw status 保留。`src/engine/decide.ts:267` 对本票 unresolved 阻止新 PLACE。这里能接住**已经进入此 engine deal 的 wire unknown**，不能解决用户资格/余额/费率 UNKNOWN，也不自动替新入口保存 opportunity→deal 身份。

## 4. DealModal 刷新与恢复的真实边界

- `TradeFlow.tsx:211,224,303-306` dealId 仅 useState；openDeal=setDealId；没有该已打开 modal 的持久化 id，刷新后不自动重开同一票。
- `DealModal.tsx:143-150` 由外部 dealId 调 useDealView；`web/src/api/queries.ts:405-414` 对该 id 读取 `/deals/:id`，非 DONE 每秒轮询；`deals.ts:244-248` 从 SQLite store 读原 deal。该部分有持久执行状态，不是持久化 UI 选择。
- **存在可复用的恢复入口**：`web/src/App.tsx:182,245,320` 全局 provider/banner；`queries.ts:464-473` 每 5 秒 `/deals?active=1`；`deals.ts:236-241` 从 store listPairs(activeOnly)，默认最多 20；`RecoveryBanner.tsx:21-48` 有活票而 modal 未开时 View 打开 halted 优先/最新 deal；`55-79` standing alert 可按 pairId 打开。它不是按原 opportunity/candidate 精确恢复；普通单腿 resting maker 被过滤，DONE 也不在 active feed。
- lost POST pending identity 与 active banner 是两条不同恢复路径。不能仅因 openDeal 存在就宣称“刷新/跨页面完整恢复已完成”，但也不应说系统完全无恢复能力。

## 5. 补充：hedge 滑点/总成本保障

- `src/engine/create.ts:24-50` DealRequest 无总成本、双腿 all-in fee/slippage cap。clipBandPct 的注释和处理对象是 A-clip（close 的 slippagePct），不是 B hedge 用户限制。
- `src/engine/decide.ts:309-317` B hedge 永远 taker MARKET IOC，没有用户给定 price；代码称 venue 自己 mark-based price-limit band 是其保护。`351-382` A-clip 才在 clipBandBp 有值时用 limit band；PairTicket 的 open pair `web/src/trade/deal.ts:38-56,78-90` 不传 clipBandPct。
- `docs/MAKER-HEDGE.md:261-263` 明确 accepted risk：hedge slippage quality，未来可加 circuit-breaker。结论：当前 preview book walk/费用估算不是实际 hedge 价、价差或总成本的硬保证。工单03若不扩大引擎范围，承诺只能限定为“资格/确认前检查+展示估算与未知”，不得声称未来 hedge 保证达标。

## 查询覆盖、限制与交接

### 临收口补查：maker 超时

- 请求支持 `timeoutSec`，没有 timeout action/“到期停止而非转市价”选项（`src/engine/create.ts:24-50`）。PairTicket 默认 300s（`PairTicket.tsx:83`），four-leg prefill 切 1800s（158-160），通过 action makerTimeoutSec（252）及 deal mapping timeoutSec（`deal.ts:55`）送出。
- `create.ts:294-302` 仅 maker 双腿建立 deadline，普通默认300s，autoPricePolicy=best 默认1800s，夹到30–3600s；maker单腿无deadline。`decide.ts:273-285` 到期 OPENING→CONVERTING（若 venue明确用户取消先 STOPPING）。
- `decide.ts:331-382` CONVERTING 先取消live maker、先补owed hedge，再用A taker IOC clips完成剩余量；open pair没有clipBand时A也是MARKET IOC。因此费用假设不能无条件一直按maker A + taker B；到期未完部分可变taker A + taker B。此为现有语义，不等于用户已明确授权新机会入口自动转taker；该产品决定留给主代理与用户。未深挖其他maker失败转换分支。

- Graph project=`home-jerel-workspace-GitHub-arbitrage-with-crossex-perp-funding-opportunities-docs`，Tier2；generation/indexed_at=`2026-10-26T23:38:27Z`，recorded_at=`2026-10-26T23:40:56Z`。实际使用 search_graph→trace_path→get_code_snippet；源中 literal 与配置用 rg/定点 sed。搜索 ExecuteControl 等 30/38 首页足以正向定位，未把未分页结果当穷尽；后续 resolveActions、resolveQty、preflightMargin、applySharedPairSizing 定向搜索完整页。
- 对依赖的26路径逐一 check_index_coverage：ExecuteControl、PairTicket、TradeFlow、DealModal、RecoveryBanner、pendingBasket、usePreview、previewBits、HoldToConfirmButton、deals route、create、preflight、preview、orders、deal mapping、finalize、queries、storage、App、loop、decide、MAKER-HEDGE、actions、cache、db、fmt；全部 metadata_match / no_recorded_issue，无 reported missed range。该信号 best-effort，不证明全图完整。关键结论均以当前源中范围交叉核验。
