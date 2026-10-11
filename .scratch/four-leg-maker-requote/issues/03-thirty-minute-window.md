Type: task
Status: resolved

# 03：三十分钟默认 maker 等待窗口

**What to build：** 四腿流程的票据默认选中新增的 30m 等待选项，用户下单前可以改；引擎在四腿流程下按三十分钟计算绝对期限。普通票据的默认值与选项集合保持不变。期限在创建时一次性确定，此后改价、部分成交、盘口异常、界面重新挂载与进程重启都不重置。

**Blocked by：** 无（可立即开始）

**Status：** ready-for-agent

## 背景

现有等待时长是三个固定选项（1m／5m／15m），默认 5 分钟；引擎侧默认值同为 5 分钟，并以夹取而非拒绝的方式限制在三十秒到一小时之间。三十分钟落在该区间内，因此**本工单不授权任何上限或下限调整**。需要改的只有两处：四腿票据的默认选项，以及四腿流程下的引擎默认值。

**验收标准**

- [ ] 等待时长选项新增 30m；四腿流程的票据默认选中它，普通永续票据保持 5m 默认与 1m／5m／15m 三个选项不变。
- [ ] 引擎在四腿流程下的默认等待时长为三十分钟；现有上下限与夹取行为一字不改。
- [ ] 不使用隐藏默认值——界面显示 5m 而实际执行 30m 是最差的一种落法，必须避免。
- [ ] 下单前仍可通过该输入调整，界面与引擎取值一致。
- [ ] 期限一经创建即持久化，改价、部分成交、盘口异常、界面重新挂载与进程重启均不重置；期限字段在创建之后没有任何路径会改写它。
- [ ] 到期判断优先于自动改价与盘口暂停；现有的显式停止、加速转换等安全状态仍保有原优先级。
- [ ] 到期进入既有转换流程：撤销剩余 maker、确认最终成交、补齐已成交部分的对冲义务，再以 taker 获取剩余数量并对冲；不得越过待定、隔离、未知撤单结果或可提交数量校验。
- [ ] 断言三十分钟是等待窗口而不是成交保证：全部目标达成即可完成，不等待三十分钟。
- [ ] 断言到期与改价条件在同一 tick 同时成立时的行为，以及已有手动停止时的优先级。

## Answer

实现完成，合并进集成分支 `feat/four-leg-maker-requote`（工作提交 `167a102`，测试强化 `89ac493`，集成分支合并提交 `691c963`；`13a110c` 是分支内的中途合并，不是并入集成分支的那次）。工单要求的两处改动 + 一条既有不变量的断言。

**落地内容**

**(a) 引擎侧的四腿默认等待。** `src/engine/create.ts` 新增 `TIMEOUT_DEFAULT_BEST_S = 1800`，`resolveDeal` 的期限计算改为「默认值按流程选、夹取行为一字不动」：`req.pricePolicy === 'best'` 时默认 1800 秒，否则仍是 300 秒；`Math.min(3600, Math.max(30, t))` 未改。上下限常量、夹取语义、单腿 maker 无期限（`deadlineAt = null`）全部保持原样。为让 `'best'` 能被识别，`PairRow.pricePolicy`、`DealRequest.pricePolicy` 与 web 的 `DealPair`/`DealRequest` 联合类型一并加入 `'best'`——这部分与工单 01 重叠，合并后两者一致。

**(b) 票据默认与选项。** `web/src/trade/PairTicketBits.tsx` 的 `TimeoutChoice` 增为 `'60'|'300'|'900'|'1800'`；`TIMEOUT_CHOICES`（普通票据，1m／5m／15m）保持不变，另加 `TIMEOUT_CHOICES_FOUR_LEG`（含 30m）。`MakerHedgeControls` 新增可选 `timeoutChoices`，默认取普通集合。`web/src/trade/PairTicket.tsx` 新增 `fourLeg` 状态：由 prefill 的 `strategy: 'four-leg'` 打标（`TradeFlow.tsx` 的 `PairPrefill` 新字段），打标时默认选中 30m 并显示四选项集合；`StrategyWizard.tsx` 的 step-2 票据（既有 `armPerps`／`prefillPair` 通道）即发出该标记。**没有隐藏默认值**：显示的选择与送出的 `makerTimeoutSec` 都是 1800，UI 测试直接断言二者一致。

**(c) 期限不变量。** 无需新代码——合并后复核确认 `deadlineAt` 仍只有创建时一个写者（`create.ts` → `db.ts` 的 `createPair`），`PairPatch`/`PAIR_COLS` 的 `deadlineAt` 仍是无人调用的潜在能力，工单 01 的改动没有引入新写者。新增测试断言它跨越部分成交、改价、盘口异常、界面重挂载与真实文件库重开都不移动。

**范围隔离的实现取舍（需要评审确认）**

规格把范围隔离落在 UI 与创建路径（`price_policy === 'best'`），且工单明令不得新增 `origin`/`strategyId`。本实现据此：四腿票据在 confirm 时给 maker action 注入内部标记 `bestQuote`，`web/src/trade/deal.ts` 由它产出 `pricePolicy: 'best'`；普通票据连 `bestQuote` 都不会出现，仍只能产出 `'fixed'`/`'touch'`。这没有新增请求字段（`bestQuote` 是 action 上的前端内部标记，不是 deal 请求字段），也不猜测交易所／标的／持仓。**但**：工单 01 的 Answer 明确把「UI 显式发出 `'best'`」列为未做项，工单 02（报价行为）与之耦合，本实现把这半个 UI 发射提前了。若集成分支认为该发射应归工单 02/07，请回退 `PairTicket.tsx`/`deal.ts` 的 `bestQuote` 部分——引擎默认与 30m 选项可独立保留。

**验证**

- `yarn typecheck` 通过；`yarn --cwd web typecheck` 通过；`yarn --cwd web build` 通过。
- `yarn test`：117 文件 / 2699 通过、8 跳过。
- `yarn --cwd web test`：100 文件 / 1460 通过。
- 新增测试：`tests/unit/engine-create.test.ts`（5）、`tests/unit/engine-deadline.test.ts`（8），以及 `PairTicket.test.tsx` 的「maker wait window」两例；`StrategyWizard.test.tsx` 断言 prefill 携带 `strategy: 'four-leg'`。
- 未运行 `test:live`。

**未满足 / 前提修正**

- 到期同步进入 converting 时的「撤销剩余 maker、确认最终成交、补齐对冲、taker 收尾且不越过 pending／隔离／未知撤单／可提交数量校验」——**未新写断言**。这是既有的 `decide()` 到期 → `CONVERTING` 路径，已由现有套件（`engine-loop.test.ts` 的 "timeout converts exactly like convert-now" 等）覆盖；本工单只新增了「到期后确实进入 CONVERTING」的断言，未复制既有转换路径的断言。
- 「到期优先于盘口暂停」：本工单只断言了「到期优先于同一 tick 的改价条件」。盘口暂停属工单 04，合并后的代码里尚不存在该分支，故无法断言其与到期的相对位置（规格要求该分支插在 `decide.ts:240` 之下，届时天然成立）。
- 未改动任何 `'best'` 的报价行为（工单 02）、盘口暂停（04）、预算拆分（05）。
