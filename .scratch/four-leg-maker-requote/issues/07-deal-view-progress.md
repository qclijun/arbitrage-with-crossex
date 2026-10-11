Type: task
Status: resolved

# 07：交易视图显示期限、改价用量、暂停原因与自动跟随状态

**What to build：** 交易视图显示已消耗的自动改价次数与上限、暂停原因（盘口不可用／退避中／已达上限）、以及该 deal **是否仍在自动跟随报价**。倒计时已经存在，其余为新增显示。

**Blocked by：** 02（挂同侧最优价并按落后 tick 有限自动改价）、04（盘口不可用时的报价暂停与三十秒撤销）、06（手动控制优先与恢复自动跟随）

**Status：** ready-for-agent

## 背景

现有交易视图只渲染阶段、倒计时、未对冲数量与订单表，**不渲染改价次数、暂停原因或任何拒绝计数**。改价次数与暂停原因由引擎侧投影产出后经 deal 接口送达。显示「是否仍在自动跟随」是手动固定报价得以被用户理解的**必要配套**——否则用户手动固定之后会一直以为还在自动追价。

**验收标准**

- [ ] 显示已消耗自动改价次数与上限，取自引擎的持久化事实而非前端本地状态。
- [ ] 显示暂停原因：盘口不可用／退避中／已达改价上限。
- [ ] 显示该 deal 是否仍在自动跟随报价；不在自动跟随时给出明确标识。
- [ ] 拒绝对应的故障预算**不**作为进度暴露。
- [ ] 倒计时保持现有行为；以上新增显示在阶段推进时正确更新，不残留过期数值。
- [ ] 改价次数与时间不存放为前端组件状态；前端不代替引擎执行订单操作。
- [ ] UI 测试覆盖四腿票据传播策略与等待设置、普通交易不带新策略，以及交易视图的期限／计数／暂停说明。
- [ ] 范围隔离的 UI 测试：普通永续票据无法发出新报价模式取值。
- [ ] 界面文案对本地行情能力保持诚实：成功获取不得被描述为「源盘口一定新鲜」。

## Answer

实现完成，分支 `ticket/ffm-07-deal-view-progress`，工作提交 `f616ba4`，基/集成 tip `f9b715d`（已含 01–06；tip 未移动，无需并入）。

**落地内容**

- **deal 视图新增 `progress` 段**（`src/server/routes/deals.ts` 的 `dealProgress`），路由仍是薄意图写入层，只读不改。三块内容：
  - `reprice: { used: pair.repriceCount, limit: TUNING.MAX_REPRICE_CYCLES }` —— 取自引擎**持久化**事实，前端无任何本地计数状态。
  - `pause`：`{ kind: 'book-unavailable', since }` / `{ kind: 'reprice-cap' }` / `{ kind: 'maker-backoff', until }`，否则 `null`。
  - `autoFollow: { following: pair.pricePolicy !== 'fixed', family: pair.autoPricePolicy }`。
- **暂停原因从持久化事实派生，未新增列、未新增恢复状态**（工单要求我给出裁决，见下）。
- **`DealModal` 新增读数区**（`data-testid="deal-progress"`：`reprice-usage` / `auto-follow` / `pause-reason`），置于安全信号与控件之间，随服务端视图刷新。倒计时、未对冲、订单表等既有行为一字未改。
- **补全 web `DealPair` 镜像**：`autoPricePolicy`、`repriceCount`、`postOnlyRejects`、`lastMakerPlacementAt`、`bookOutageStartedAt`。此前这些字段在运行时已随 `pair` 送达但类型未声明——类型对 payload 说谎比没有类型更糟。`postOnlyRejects` 仅为保真而声明，**不**参与展示。
- **`makeFourLegDealView`** 夹具（`pricePolicy`/家族均 `'best'`），与 `makeDealView` 默认的普通 deal 形状区分。

**暂停原因的裁决（工单要求明确说明）**

选择**从持久化事实派生**，不新增持久化「原因」，也不新增恢复状态机。理由：`decide()` 发出的 idle 原因串是瞬时的，`perform()` 不写 `idle` 动作，因此任何持久化「原因」都会成为 AGENTS.md 明令禁止的平行恢复状态；而从引擎**决策所依据的同一批持久化事实**派生，视图与循环天然一致，重启后也不会撒谎。映射为：`bookOutageStartedAt > 0` ⇒ 盘口不可用；`repriceCount >= MAX_REPRICE_CYCLES` ⇒ 已达改价上限；`makerNotBefore > now` ⇒ 退避中。**盘口不可用优先于上限**——盘口不可报价时无论额度如何都无法改价，且它才是 30 秒撤销判定的依据。

**测试中发现的真实缺口（已修）**：`bookOutageStartedAt` 只在「OPENING 且盘口可报价」的 tick 上被清零，deal 一旦离开 OPENING 就不再清零。因此横跨盘口故障完成 convert 的 deal 会把过期的故障标记带到终态，读数会报一个已经不存在的暂停。`dealProgress` 因此把 pause 限定在 `mode === 'OPENING'`（报价只存在于该阶段）。先写红测（`reports no pause once the phase has advanced past quoting, even with a stale outage marker`）再修。

**未暴露拒绝预算**：`postOnlyRejects` / `pocRejects` / `hedgeRejectStreak` 均不进 `progress`；有一个断言对序列化后的 `progress` 做 `/postOnly|pocRejects|reject/i` 反证。

**本地行情诚实性**：文案只描述暂停与跟随，绝不把成功获取表述为「源盘口一定新鲜」。有一个测试对三种 progress 形态断言读数区不含 `fresh|stale|up-to-date|verified|source book` 一类断言。

**验证**

- `yarn typecheck` 通过；`yarn --cwd web typecheck` 通过。
- `yarn test`：**122 文件 / 2821 通过 / 8 跳过**（基线 122 / 2815，新增 6 例）。
- `yarn --cwd web test`：**100 文件 / 1467 通过**（基线 100 / 1460，新增 7 例）。
- `yarn --cwd web build` 成功。
- 提交后再次跑满全部四项，结果同上。
- 未运行 `test:live`。
- 新增服务端例（`tests/server/deals.test.ts`，6 例）：持久化计数直读、盘口转不可用后的暂停、**驱动循环真实消耗一次改价后读数变为 1**、达上限暂停且序列化后不含拒绝预算、阶段推进后不残留暂停、`'best'` 自动跟随 / 手动 pin 后 `following:false`。
- 新增/扩展 web 例（7 例）：`DealModal.test.tsx` 计数与上限、三种暂停原因、`auto-follow` 的 not-following 明确标识、阶段推进后暂停消失、普通 deal 无新策略声明、无源盘口新鲜度断言；`ExecuteControl.test.tsx` 新增「普通 maker 意图发不出 `'best'`」（范围隔离 seam）。

**未满足 / 越界声明**

- **未改引擎**：`decide()`、`loop.ts`、任何预算/阈值、re-peg 语义（工单 06 已定）均未改。
- **未新增用户可调入口**，未暴露拒绝计数。
- 工单验收里「UI 测试覆盖四腿票据传播策略与等待设置、普通交易不带新策略」由工单 03 的 `PairTicket.test.tsx` / `StrategyWizard.test.tsx` 既有用例覆盖（`strategy: 'four-leg'` → `pricePolicy:'best'` + `timeoutSec:1800`），本工单**未重复**，仅补了 `ExecuteControl` 侧「普通票据无法发出 `'best'`」这一 07 独有的范围隔离 seam。若评审要求把传播断言也归到 07，可另开工单。
- **暂停原因的分级仍有已知取舍**：`maker-backoff` 用 `makerNotBefore`（既有拒绝退避）。这是一个**拒绝预算**的派生量，与「不以拒绝计数作为进度」并不冲突（它只产出布尔式的「退避中」，不产出计数），但它与 reprice 循环的 15 秒间隔门（`lastMakerPlacementAt`）不是同一件事——前者在盘口抖动时可能短暂显示。若评审认为「退避中」不应来自拒绝退避，需要引擎侧新增一个专用于报价节奏的持久化事实，本工单未做，因为那正是工单要求避免的平行状态。
