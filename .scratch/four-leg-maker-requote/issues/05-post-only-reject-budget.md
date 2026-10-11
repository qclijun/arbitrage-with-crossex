Type: task
Status: resolved

# 05：post-only 拒绝的独立预算

**What to build：** 使用自动报价的 deal，post-only 连续被拒单独计数，上限与改价额度同级（二十），耗尽后进入转换流程以 taker 补齐剩余量，而不是停在诚实部分成交。taker 撮合被拒或白打仍走原有预算与停止规则，两条预算互不消耗。

**Blocked by：** 02（挂同侧最优价并按落后 tick 有限自动改价）

**Status：** ready-for-agent

## 背景

挂同侧最优价本身就位于盘口最容易被穿越的位置，随着盘口在「我们观测」与「交易所处理」之间移动，post-only 拒绝会成为**预期内的高频事件**，而不是「价格一直挂错」的故障信号。现有实现把三种语义不同的失败——post-only 会穿越、taker 撮合被拒、taker 撮合白打——计在**同一个**预算上并共用一个上限，且统一导向诚实部分成交。新策略下这种合并会让一次盘口抖动直接掐断用户期望的 taker 补齐路径，使 deal 停在部分成交而不是到期后完成剩余量。

**验收标准**

- [ ] 使用自动报价的 deal，post-only 拒绝单独计数，上限二十；上限与改价额度同级但**互相独立**，任一耗尽不消耗另一个。
- [ ] post-only 预算耗尽后进入转换流程，以 taker 补齐剩余量，而不是停在诚实部分成交。
- [ ] taker 撮合被拒或白打仍走原有预算与停止规则，导向诚实部分成交；不得改为进入转换——否则会退化成无限重试。
- [ ] 改价周期发起的撤单不消耗改价额度：它不是追价，是暂停。把它计入额度会让一次交易所抖动直接吃掉用户二十次追价机会中的若干次，并使「额度耗尽」这个用户可见数字失去可解释性。
- [ ] 网络查询本身不消耗任何额度。
- [ ] **现有预算的语义、上限与去向一个字都不改**：普通永续双腿、单腿、平仓与存量 deal 全部保持「拒绝若干次后诚实部分成交」。
- [ ] 断言两条预算互不消耗：分别打满其中一条后，另一条的计数与上限不受影响。
- [ ] 断言普通双腿、单腿、平仓及存量 deal 的既有拒绝预算语义未被改变——这是本条最容易发生的回归，需要专门断言。
- [ ] 终态报告基于已确认的 venue 成交，交易所拒绝剩余量时如实报告。

## Answer

**Status: resolved。** commit `79f3e76`（工作），`1d2033f`（并入集成 tip 的合并）。

Post-only 拒绝从既有共享预算中**拆出**，落到一个**新增的持久化计数** `postOnlyRejects`（上限 `TUNING.MAX_POST_ONLY_REJECTS = 20`，与改价额度同级但完全独立）。仅对 `pricePolicy === 'best'` 的 deal 生效；耗尽后 `decide()` 在 OPENING 的无挂单分支进入 **CONVERTING**（撤单并以 taker 补齐剩余量），而不是停在诚实部分成交。

### 改了哪里

- **persisted 字段**（按工单 01 的 `pair` 列模式，七处齐全）：`types.ts` 的 `PairRow.postOnlyRejects`；`db.ts` 的 SCHEMA DDL、`PairDbRow`、`toPair`（`?? 0` 兜底）、`PairPatch`、`PAIR_COLS`、`createPair` 的列名 + 占位符 + 参数（33 列 33 `?`）、`migrate()` 的 `pair` 列探测分支与重建 DDL；`create.ts` 的行构造。
- **计数分派**（`loop.ts`）：新增 `bumpPostOnlyWall`（只动 `postOnlyRejects` + 退避，不碰 `pocRejects`），与既有 `bumpClipWall` 并列。两个入口：`applySnapshot`（观测到的 insta-cancel，`isPostOnlyReject`）与 `performPlace`（create-time business reject 且 `POC_REASON` 命中）。二者都以 `pair.pricePolicy === 'best'` 为门。A-leg 成交时两个计数各自独立归零（连续语义）。
- **去向**（`decide.ts`）：OPENING 无挂单分支新增 `best && postOnlyRejects >= MAX_POST_ONLY_REJECTS → setMode CONVERTING`，位于「target reached」判定之后、既有 `pocRejects` STOPPING 判定之前。非 `'best'` deal 不携带该计数，直接落到原预算。

### 保持不变

三种既有预算（`pocRejects` 上限 **5** / `hedgeRejectStreak` 上限 **3** / 改价额度 **20**）的语义、上限、去向**一个字符未改**。taker clip 被拒/白打仍走 `pocRejects` → STOPPING 诚实部分成交；普通双腿、单腿、平仓、存量 deal 走原路径原上限（测试用**字面 5** 独立断言，非取常量，避免同义反复）。

### 验证

- `yarn typecheck`：通过。
- `yarn test`：**121 文件 / 2798 通过 / 8 跳过**（并入 tip 后）。单文件 `tests/unit/engine-post-only-budget.test.ts` **21 例全过**。
- `yarn --cwd web typecheck` / `yarn --cwd web test`：未改 web（`git diff 5281ed0 -- web/` 为空），故未跑。
- 并入集成 tip（`9f50e80`，含工单 04）时在 `src/engine/{types,db,create}.ts` 与 9 个测试文件冲突；全部为**相邻新增**，按「两种意图都保留」逐一解决（04 的 `bookOutageStartedAt` 与 05 的 `postOnlyRejects` 并存；`decide.ts`/`loop.ts` 自动合并，已核验两处新增分支均在）。合并后重跑全量通过。
- 未运行 `test:live`。

### 覆盖到的验收点

两条预算互不消耗（分别打满一条，另一条计数与上限不变）；post-only 耗尽→CONVERTING→以 taker 补齐至满额（终态报告基于 venue 真值）；未耗尽不提前转换；taker clip 被拒与白打仍走原预算与停止规则、**不**退化为无限重试；改价周期撤单与网络观测不消耗 post-only 预算；终态报告如实反映已确认成交（venue 拒绝剩余量时如实报告、不谎报完成）；**普通双腿/单腿/平仓/存量 deal 的既有预算语义未变**（含「交给普通 deal 20 次拒绝仍在上限 5 停止、且绝不转换」这条头条回归断言）。

### (A) 计数器生命周期的裁定 —— 无跨阶段污染，无需在模式边界重置

比较了「post-only 计数**单调、不因成交归零**」与「**随 A-leg 成交归零**（连续语义，与它拆分出的 `pocRejects` 一致）」两种设计后，**选择后者（连续）**：工单与规格的标题是「post-only **连续**被拒」，且它与 `pocRejects` 镜像对称，对用户更可解释（「累计 20 次」会把两小时里孤立、各不相同的挂单尝试相加，语义难解释）。**未引入任何模式边界重置。**

「OPENING 阶段的 post-only 拒绝会掐断 CONVERTING 路径」这一风险经核验**不成立**，原因是：

1. 对 `'best'` deal，post-only 拒绝**完全不再进入** `pocRejects`（二者互斥）；
2. 一个「会跨市场」的挂单若被判为**普通** rejection（非 `POC_REASON`），在 OPENING 分支会在 `pocRejects` 达 5 时**先进入 STOPPING**（OPENING 的 `pocRejects` 判定先于进入挂单）——也就是说它永远进不了 CONVERTING；

因此进入 CONVERTING 时 `pocRejects <= 4 < 5`，该计数器不会即时宣判 A-leg 失败。**但更关键的是**：即便人为把 `pocRejects` 预置为 ≥5 并进入 CONVERTING，`decide()` 的 CONVERTING 分支会先**以 taker 提交 clip**（`place`），成功即完成剩余量；只有**连续零进展**（被拒/白打）才在 5 次后停止。这正是「转换自身只统计发生在其阶段的失败」所要求的行为，且无需任何重置。已分别用两条跨边界测试钉死：`pocRejects` 上限 5 时 CONVERTING 仍以 taker 补齐；OPENING 期 4 次 post-only 拒绝后 CONVERTING 只统计转换期失败（2，而非 4+2=6）。

**结论：这是实现层可定的事，不需要升级到规格层决策**；本工单已记录裁定与理由。

### 判断取舍（工单未完全钉死，列出请评审）

1. **「连续」= 随 A-leg 成交归零**（同 `pocRejects`）。因被拒挂单是即时死亡，N 次连续 = 连挂 N 次都在落单前被拒。这与单调的**改价额度**不同（后者刻意不归零）。
2. **`bumpPostOnlyWall` 沿用 `POC_BACKOFF_MS`（2s）退避**，与 `bumpClipWall` 一致——20 次拒绝仍是 40s 内可完成，符合「预期内高频事件」的意图。
3. **达到上限时发 `warn` 级告警**（措辞为「以市价补齐剩余量」，非「放弃」），与 `bumpClipWall` 的 `error`「stopping with whatever filled」区分。拒绝类预算按规格**不进入进度展示**，故未触碰 deal view。
4. **非 `'best'` deal 的归零写路径逐字符不变**：`pocRejects` 与 `postOnlyRejects` 各自独立 `updatePair` 单列写入（未合并成一次两列写）。
5. **超范围守卫覆盖**：新增只作用在既有 `pocRejects` 检测器**旁侧**，未改动任何既有检测器/分支的值或去向。

### 未满足 / 前提修正

- **工单 04、06、07 均未触碰**（04 仅作为并行分支合并进来；06 手动优先级、07 UI 展示不在本工单）。web 代码未改。
- **无新增 UI**：拒绝类预算按规格不属于进度，无可展示项。
- **一次对工单 02 既有断言的修正**：`tests/unit/engine-best-quote.test.ts` 有一处断言「`'best'` post-only 拒绝后 `pocRejects === 1`（旧预算不变）」——这条断言**正是本工单要推翻的语义**，已改为断言 `pocRejects === 0` 且 `postOnlyRejects === 1`。这不是回归，是工单 05 的核心所在。
- **未做**：源盘口时间戳、live 测试、任何真实下单。
