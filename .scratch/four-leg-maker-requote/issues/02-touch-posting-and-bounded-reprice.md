Type: task
Status: resolved

# 02：挂同侧最优价并按落后 tick 有限自动改价

**What to build：** 四腿建仓后永续对冲流程创建的 deal，maker 腿初始按同侧最优价挂单——买单挂买一、卖单挂卖一，保持 post-only。此后挂单落后盘口达到阈值时自动改价，让报价跟随移动的市场，但改价有节流与次数上限，不会无限追价；额度耗尽后保留最后一次报价，直到成交、手动操作或绝对期限。已确认成交仍然优先以市价对冲，不等待全部 maker 成交。

这是本次功能的核心切片：它让四腿用户第一次能够「挂得进盘口、并且跟得上盘口」，同时把追价的代价限制在可解释的范围内。

**Blocked by：** 01（四腿报价模式与 pair 表迁移前置）

**Status：** ready-for-agent

## 背景

旧报价策略把 maker 挂在同侧最优价**之外一个买卖价差**，盘口不动时几乎不可能成交，导致用户选了 maker＋hedge 却长时间零成交，最后两条永续都付出 taker 手续费。新策略改为挂同侧最优价本身。三个报价取值的分工是：固定价只挂用户给出的价格；价差外挂同侧最优价之外一个买卖价差；最优价挂同侧最优价本身。**旧取值不动。**

**验收标准**

- [ ] 四腿流程创建的 deal 初始买单挂买一、卖单挂卖一，且为 post-only；普通永续双腿、单腿、平仓与存量 deal 不启用该策略，判定只依据报价模式取值，不依据交易所名称、标的或账户持仓猜测范围。
- [ ] 取整与精度沿用既有的安全格式化路径：买入向下、卖出向上取整，Hyperliquid 的五位有效数字按同方向截断，截断后按同方向重贴最小 tick——三个动作必须同时成立；格式化后无法形成合规 resting 报价时不盲目挂单。
- [ ] 落后按下式度量：**格式化后**的挂价与**当前**同侧最优价之间，按该合约最小 tick 折算的格数达到两个及以上（买单挂价低于买一，卖单挂价高于卖一）。
- [ ] 差值不足两个 tick、恰好等于同侧最优价、或挂价更积极时，不得仅为追随盘口而撤单。
- [ ] 自动改价要求距上次 maker 挂单至少十五秒；用「距上次改价」代替会让短暂停顿后立刻再改一次，因此必须记录上次挂单时刻。
- [ ] 自动改价上限二十次；额度耗尽后保留最后报价至成交、手动操作或绝对期限，次数耗尽本身**不触发**转 taker。
- [ ] 改价额度是单调的持久化事实，不因成交归零；发起撤单之后、结果可知之前写入，重试撤单、处理未知结果与重启恢复都不重复计数。
- [ ] 改价周期遵循：发起撤单 → 确认原单不再可能继续成交 → 核对最终累积成交 → 先处理新增成交的可提交对冲数量 → 再为未成交且未被订单预留的剩余数量挂新 maker。沿用现有最小数量、名义金额、数量步长与 dust 报告规则。
- [ ] 已确认成交部分及时以 taker 对冲，不等待全部 maker 成交，也不把第二腿改成 maker。
- [ ] 普通双腿、单腿、平仓与存量 deal 的报价与等待行为一字不改。
- [ ] 以现有引擎模拟器驱动完整 observe → project → decide → act 循环验证，断言 venue 调用、订单成交、持久化状态与最终报告；不测某个 helper 的返回值，也不复制实现表达式。
- [ ] 落后口径用格式化后的挂价比较：构造一个五位有效数字截断会让出多个 tick 的价格量级，断言不会出现「已按最优价挂出却永远算作落后」的重挂循环。
- [ ] 边界断言：不足两个 tick 不改、刚好两个 tick 可改；十五秒之前不改、到达十五秒可改；挂价更积极不为跟随而撤单。
- [ ] 竞态断言：撤单期间新增成交只对冲一次，重挂数量不含已成交或已预留数量；无超额 acquire、无超额 hedge、无重复 client id 提交。
- [ ] 重启断言：改价次数与上次挂单时刻在进程重启后保留，不重置。

## Answer

**已落地。** 提交 `a9f9c2b`（合并 `a071d56`，已并入集成 tip `691c963`）。

### 改了什么

- **新共享可用性判定 `src/engine/bookQuality.ts`**：`isQuotableBook` 要求买一与卖一同时存在、均为正有限值、且 `ask > bid`。单边盘口与交叉盘口都判为不可报价。工单 04 的盘口暂停将复用同一单元。`topOf` 把原始档位提升为 `{bid,ask}`（非正/非有限一律 null，绝不降级为 0）。`bestQuotePrice` 返回**裸同侧最优价**（BUY 取买一、SELL 取卖一，无价差偏移），并经 `formatRestPrice` 格式化（BUY 向下、SELL 向上取整；Hyperliquid 五位有效数字同方向截断后同方向重贴 tick）。
- **新 port 方法 `VenuePort.bestQuote`**（`venueGate.ts`，独立缓存键 `best:…`）。旧 `touch`（价差外一个价差）与 `fixed` 行为一字未改。
- **`decide.ts` 保持纯粹**：新入参 `ctx.bestA: string | null`。`'best'` 的挂价**只有** `ctx.bestA`，没有 `?? pair.limitPrice` 回退——反证了工单 04 指出的「取不到盘口就暂停」不可达的问题。新增纯函数 `lagTicks(resting, best, tick, side)`：比较**格式化后**挂价与**格式化后**当前同侧最优价之间的整 tick 数。
- **`loop.ts` 接线**：`needBest` 谓词（仅 OPENING 且 `pricePolicy==='best'`）每 tick 取一次同侧最优价；`performPlace` 在 maker 挂单时写入 `lastMakerPlacementAt`（与 `limitPrice` 同一次写回，写前生效）；`performCancel` 在**发起撤单之后、结果可知之前**消费一次额度，并以 `cancelRequested`（持久化）作为「本轮已发起」的指纹，令重试/未知结果/重启不重复计数。
- **`Action` 的 cancel 增加 `reprice?: boolean`**；`TUNING` 增 `REPRICE_LAG_TICKS=2`、`REPRICE_MIN_INTERVAL_MS=15_000`、`MAX_REPRICE_CYCLES=20`。
- **测试 harness 扩展**（保留 `touchA`/`refPrices`/`readsFail` 原义）：`FakeVenue` 增加每合约真实双边盘口 `books`、仅杀盘口读取的开关 `bookReadsFail`、`bestQuote()` 实现与 `bestQuoteCalls` 调用记录；`mkWorld` 增加 `storePath`/`reopen`/`pairId` 以支持文件库重启测试。

### 验证（合并后重跑）

- `yarn typecheck`：通过。
- `yarn test`：**119 文件 / 2752 通过 / 8 跳过**（基线 115/2686/8；新增 4 文件：`book-quality`、`engine-best-quote`，以及 03 带来的 `engine-create`/`engine-deadline`）。
- `yarn --cwd web typecheck`：通过；`yarn --cwd web test`：**100 文件 / 1460 通过**。
- 新增/扩展测试全绿：`tests/unit/book-quality.test.ts`（10）、`tests/unit/engine-best-quote.test.ts`（25，完整 observe→project→decide→act 循环）、`engine-decide.test.ts` 的 `'best'` 段、`venue-gate-touch.test.ts` 的 `bestQuote` 段、`deals.test.ts` 的一例 API 端点驱动。
- 未运行 `test:live`。

### 覆盖到的验收点

初始 BUY 挂买一/SELL 挂卖一且 post-only（含 HL 五位有效数字安全方向截断）；三值范围隔离（`fixed`/`touch` 从不调用 `bestQuote`）；格式化落后口径在 61717 量级不会出现「已挂最优却永远算作落后」的重挂循环；不足两 tick 不改、恰好两 tick 改、15 秒前不改、到 15 秒改、更积极不撤；先撤确认再重挂；撤单期间成交只对冲一次、重挂只覆盖剩余、无重复 client id；额度不被 post-only 拒绝、盘口异常、网络观察、非改价撤单消费，不因成交归零；20 次上限含未知/重试撤单不重复计数、重启不重置，耗尽后保留最后报价不转 taker；文件库重开保留 `repriceCount`/`lastMakerPlacementAt`；`crashAfterCommit` 在撤单提交边界注入，证明恰好消费一次；partial fill 及时市价对冲、deal 不等到期即完成；leg B 恒为 ioc。

### 判断取舍（工单未完全钉死，列出请评审）

1. **撤单消费额度的「单个原子事实」是按两个提交实现**（`cancelRequested` + `repriceCount`），与 `performPlace` 的写前模式完全平行；`crashAfterCommit` 注入在**两者提交之后、wire 调用之前**。若崩溃恰好落在两个提交之间（本项目代码里不存在——两条 `updatePair`/`updateOrder` 语句之间无任何可崩点），则 `cancelRequested=1` 而额度未消费，结果是该次改价**少计一次**（偏保守，绝不超发）。工单要求「发起之后、结果可知之前」写入，本实现满足。
2. **重挂后 15 秒从「本次挂单」重新计时**（`lastMakerPlacementAt` 在 `performPlace` 内写），因此下一次改价至少再等 15 秒；若某次撤单结果长期未知，15 秒门不会因此失效。
3. **`decide.ts` 里「撤单中」的重试分支（`m.cancelRequested` 即重发撤单）只对 `'best'` 生效**。非 `'best'` 的撤单重试仍走既有路径（作者已确认既有测试如 "re-sends the cancel while an unconfirmed one leaves the maker OPEN" 不回归）。
4. **`ctx.bestA` 传入 `decide` 前未在 loop 再做一次可用性判定**——判定留在 `bookQuality`/venue 适配器，`decide` 只收「已格式化或 null」的纯值，符合「`decide` 保持纯粹」。
5. 挂价的**名义金额/最小数量**沿用 `sizeFor`（以挂价做 min-notional 检查），与 `fixed`/`touch` 一致，未改 dust 规则。

### 未满足 / 前提修正

- **`'best'` 的盘口暂停与 30 秒撤销（工单 04）未实现**，按范围纪律只交付共享判定 `isQuotableBook`。目前盘口不可用时 `'best'` 只是「不挂/不改」，不停表、不撤单——这正是工单 04 的语义。
- **post-only 拒绝的独立预算（工单 05）未实现**：`'best'` 下 post-only 拒绝仍走既有 `pocRejects`（上限 5，去 STOPPING），额度与去向**未拆分**——工单 05 负责。已断言 post-only 拒绝不消费改价额度。
- **`'best'` 首次挂单在创建时仍要求一个正价格**（`create.ts` 的既有校验对所有 maker deal 生效）。该价格对 `'best'` 只是初值 `limitPrice`，引擎随即改用盘口价。**未删除或放宽该校验**（会波及 `fixed`/`touch`）；若 UI 希望在 `'best'` 下不传价格，需要一张单独工单处理创建校验，本工单未做。
- **状态与进度的展示（工单 07）未实现**：`repriceCount`/`lastMakerPlacementAt` 已持久化，但未在 deal view 暴露，也未加暂停原因。
- **未改动 web**：`'best'` 的 UI 发射入口由工单 03 提供（`bestQuote` 内部标记 → `deal.ts` 映射），本工单未触碰，也未新增第二种发射方式。
- 规格「auto-reprice 在任何情况下都不得覆盖 `'fixed'`」：本实现的 `'best'` 分支只在 `pricePolicy === 'best'` 时触发；用户显式固定价会把 policy 改为 `'fixed'`（既有 re-peg 路径），自动改价随之停用。此语义由既有路径保证，本工单未新增断言（归工单 06）。
