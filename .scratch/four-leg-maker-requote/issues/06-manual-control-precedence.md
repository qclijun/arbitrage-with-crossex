Type: task
Status: resolved

# 06：手动控制优先与恢复自动跟随

**What to build：** 用户在自动改价运行期间手动固定报价后，自动改价在任何情况下都不得覆盖它；恢复自动跟随走**既有**的改价命令——带显式价格时写入固定价，不带价格时写回自动跟随并立即按当时的同侧最优价重算。取不到新鲜报价时该命令失败，而不是静默把自动跟随关掉。手动停止、加速转换与显式改价的既有优先级、幂等性与权限要求保留。

**Blocked by：** 02（挂同侧最优价并按落后 tick 有限自动改价）

**Status：** resolved

## 背景

现有改价命令已经能在「按用户给出的价格」与「按新鲜同侧报价」两种模式间切换，因此恢复自动跟随**不需要新增用户可调入口**，复用这条既有命令即可。这条是本规格与既有控制面之间的收口：自动化再强，用户的手动干预必须能压住它，且必须能被用户明确地撤销。

**验收标准**

- [ ] 手动固定报价后，自动改价在任何情况下都不得覆盖固定价，直到 deal 结束或用户显式恢复自动跟随。
- [ ] 恢复自动跟随复用既有改价命令：带显式价格时写入固定价；不带价格时写回自动跟随并立即按当时的同侧最优价重算。
- [ ] 不新增用户可调入口、不新增按钮或参数来承担该恢复动作。
- [ ] 取不到新鲜报价时该命令失败并如实报错，而不是静默把自动跟随关掉——保留现有「不取新鲜价就不执行」的失败行为。
- [ ] 手动停止、加速转换与显式改价的既有优先级、幂等性与权限要求全部保留。
- [ ] 自动化不得反转用户干预：断言手动固定后的 deal 在盘口大幅移动时不会自行改价。
- [ ] 盘口暂停或保留原单不得绕过待定、隔离、对冲墙与停机等既有安全行为；需要断言这些状态仍按原优先级生效。
- [ ] 界面不代替引擎执行订单操作，deal 接口保持薄意图写入层。

## Answer

实现完成，分支 `ticket/ffm-06-manual-control-precedence`，工作提交 `15552eb`，合并集成 tip `5e33158`（并入 01/02/03/04）。

**落地内容**

- **「手动固定后自动改价不得覆盖」已由既有路径保证，本工单补齐断言。** 工单 02 让改价分支只在 `pricePolicy === 'best'` 时触发，而用户显式改价（既有 re-peg 路径）把策略写成 `'fixed'`，因此自动改价随之停用。新增测试以完整 observe→project→decide→act 循环断言：盘口大幅移动（远超两 tick、且已过 15 秒门）后，固定价 deal 既不撤单也不重挂、`repriceCount` 保持 0、`limitPrice` 与在挂订单的 clientText 都不变，且 `bestQuote` 一次都不被查询。
- **恢复自动跟随复用既有 re-peg 命令**：带显式价格 → `'fixed'`；不带价格 → 写回该 deal **自己的**自动跟随策略并按当时的同侧报价重算。
- **修复路由硬编码 `'touch'` 的缺口**（本工单核心）：`src/server/routes/deals.ts` 的 re-peg 无价格分支原先把策略写死为 `'touch'` 并取 `venue.touch`，对四腿 deal 会静默把报价语义换回旧的「价差外」策略。现改为按 deal 的自动跟随策略取值：`'best'` → `venue.bestQuote` 与 `'best'`；否则维持 `'touch'` 与 `venue.touch`。
- **新增持久化字段 `PairRow.autoPricePolicy`（`auto_price_policy`，`'touch' | 'best'`，默认 `'touch'`）**，记录 deal 的自动跟随家族策略，创建时确定（四腿 → `'best'`，其余 → `'touch'`），从不改变、无用户可调写入路径。之所以必须新增：固定后的 deal 其 `pricePolicy` 是 `'fixed'`，无法表达它原本是 `'best'` 还是 `'touch'`。四值贯串：SCHEMA、pair 表 ADD COLUMN 迁移分支、`toPair` 的 `?? 'touch'` 兜底、`PairPatch`/`PAIR_COLS`、`createPair` 的列/占位/实参。**未新增 origin/strategyId 一类字段**，范围判定仍是 `price_policy === 'best'`。
- **取不到新鲜报价时命令失败并如实报错**：无价格分支先按家族策略取价，取不到即抛 400（错误文案含 "no fresh"），**不写策略**——否则会把自动跟随静默关掉（deal 会保留留存价、永不跟随），与用户意图相反。
- **不新增用户可调入口**：路由只接受 `price`；多余 body 键被忽略。新增测试传 `{ pricePolicy:'best', autoPricePolicy:'best', autoFollow:true, price:'2471' }`，断言只写价格、策略被钉为 `'fixed'`、家族不变。
- **既有优先级/幂等/权限保留**：新增断言覆盖 stop / convert / quarantine / pending 冻结 / hedge wall halt 在 `'best'` deal 上仍按原顺序生效，且都优先于自动改价；权限断言无 token 时 re-peg 返回 401 且意图不变。

**验证**

- `yarn typecheck` 通过；`yarn --cwd web typecheck` 通过。
- `yarn test`：**121 文件 / 2794 通过 / 8 跳过**（合并 04 后重跑）。
- `yarn --cwd web test`：100 文件 / 1460 通过。
- 新增/扩展：`tests/unit/engine-manual-control.test.ts`（12，完整循环）；`tests/server/deals.test.ts` 新增 5 例（家族恢复、fail-loudly、无新入口、授权、普通 deal 恢复 touch）；`tests/unit/engine-store-migration.test.ts` 断言旧库 `autoPricePolicy` 默认 `'touch'` 且可写回；`engine-sim.ts` 的 `mkWorld` 同步设置家族策略。
- 未运行 `test:live`。

**判断取舍（工单未完全钉死，列出请评审）**

1. **家族策略的载体选择。** 工单要求「不得硬编码、不得按交易所/标的/持仓猜测、不得新增来源字段」。我选择新增一个持久化字段 `autoPricePolicy`（创建时写入、之后只读），而不是在停止改价那一刻把策略暂存到别处——理由是暂停时刻无原子暂存点，且暂停值会与「家族」语义混淆。评审若倾向不新增字段，可改为在 `commands.repeg` 里由调用方显式传入目标策略（路由据当前 deal 是否曾以 `'best'` 创建来判断），但那需要另一处持久化判断依据，反而更容易退化成猜测。
2. **恢复时的报价来源与初值。** 无价格分支对 `'best'` 调 `venue.bestQuote`（裸同侧最优价）并把返回值写入 `limitPrice`；对 `'touch'` 仍调 `venue.touch`。即写入的初值随家族策略不同。这符合「立即按当时的同侧最优价重算」。
3. **`'fixed'` 出生 deal 的家族设为 `'touch'`**，以保留既有「Re-peg to touch」把普通 pinned deal 交还给盘口的行为（既有 server 测试 `re-peg to touch restores book tracking on a pinned deal` 即此断言）。若评审认为 `'fixed'` 出生应「恢复为 `'fixed'`」，需另开工单——本工单未改该既有语义。
4. **`autoPricePolicy` 设为必填**，因此为若干既有测试的 `PairRow` 字面量补了该字段（与工单 01 为新列采用同一做法）；未给生产代码加默认参数路径，以免「忘记设置」静默产生一个假的家族。
5. **未改 web。** 界面「Re-peg to touch」按钮只发 `{ id }`，引擎按 deal 家族恢复；文案仍是通用说法，是否随工单 07 的「是否仍在自动跟随」指示一起改写文案，留给 07。

**未满足 / 越界声明**

- **工单 07 的展示未做**：未在交易视图暴露家族策略、改价次数或暂停原因。
- **工单 04 的盘口暂停/30 秒撤销、工单 05 的 post-only 独立预算未做**（并行）。相关断言只覆盖「这些安全状态不被绕过」，不覆盖 04/05 自身语义。

## Comments

### 2026-10-11 完成状态复核

结论：实现与离线验收已完成，顶部与正文状态统一为 `resolved`。原始验收清单和历史 Answer 保留。

固定价压制自动改价、无价格 re-peg 恢复原策略、报价失败不改意图、权限与安全优先级：engine-manual-control.test.ts、tests/server/deals.test.ts。最终修复还覆盖首次固定报价与恢复 best。

核查实现提交 `36dbcaf`（含最终修复 `9f12669`）；核查结束时 HEAD 为 `1e42912`，其新增 stop 脚本未改本功能实现。当前重新运行 `yarn verify` 通过：根测试 122 文件 / 2840 通过 / 8 跳过，web 测试 100 文件 / 1469 通过，两项类型检查通过；`yarn --cwd web build` 通过。详细记录见 [review.md](../review.md#completion-status-recheck-2026-10-11)。

此状态不表示部署或实盘验证完成；[实盘验证清单](../live-validation-checklist.md) 尚未执行，不勾选其检查项。
