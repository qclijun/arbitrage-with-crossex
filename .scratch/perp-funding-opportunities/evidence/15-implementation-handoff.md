# 工单15实施交接

目标：[归属契约](../ownership-and-risk.md)的持久数量账。用户确认接缝（2026-10-28）：15交付切片账本身（账本步骤3、Store接口、engine逐tick按各腿实际累计成交差额幂等记账、对账、带slice的减仓校验、`GET /api/slices`、显式恢复API）；创建/加仓由12、当前认领由17调用；四腿/三腿与独立票deal不自动建切片。场外差异：合约首次有切片时（须无活动执行）以当时实际净仓为基线，可解释净仓＝基线＋engine在该合约所有成交；不等即UNKNOWN，在途只报在途；恢复须用户显式给观测净仓、逐切片调整与证据。超额减仓：切片记到零，超额记未归属并告警、合约待恢复。账户为单一常量`crossex`。

## 交付

- 账本步骤3（`ledger/slice-schema.ts`，附加）：`strategy_slice`、`slice_leg`（账户/合约/方向/单位/实际qty）、`deal_slice`（deal→切片及open/add/reduce、腿映射）、`contract_book`（可解释净仓、基线时间、flag）、`fill_booking`（每deal腿已记累计）、`slice_movement`（fill/claim/recover/excess/external，本机观察时间与证据，非venue逐笔时间）。`ledger-support.json`→3。
- `src/engine/slices.ts` `SliceLedger`（`store.slices`；读查询在`slice-queries.ts`）：`create`（腿合约须无活动deal；同合约已有反向且有量或正在开仓的切片拒绝，attach开/加时复查；未跟踪合约须给新鲜读数作基线，基线量即未归属）、`mapLegs`/`attach`（open/add须同向非reduceOnly，reduce须反向reduceOnly；已有成交的deal不得再挂切片）、`reducible`（qty−未完成reduce deal剩余目标＝可减）、`pendingReduce`（合约上未完成reduceOnly腿剩余）、`claim`（17用：读数须完全对账，且不超过同向未归属量）、`recover`、只读视图。写入经`inSavepoint`原子、可嵌套（亦供12在`admit`内使用）。
- `src/engine/slice-booking.ts`：每deal腿累计成交只按增量记一次；缩小拒记并告警；跟踪合约的可解释净仓随基线时刻及之后创建的engine deal成交变化（更早的已含于基线）；reduce不把切片记成负，超额记`excess`、设flag并告警。`loop.ts` `tickPair`在每tick结束（含抛错）后记账，`startLoop`启动时补记所有被跟随deal（崩溃或记账失败遗留），`claim`/`recover`前亦先补记；仅写库、不碰venue，不改变一tick一wire。
- `src/engine/slice-reconcile.ts`（纯）：`unknown`（读不到）→`in-flight`→`untracked`→`needs-recovery`→`external-change`（实际≠可解释）→`over-attributed`（归属不在实际同侧之内，或同合约切片双向都有量）→`reconciled`；`unknown`字段标出跟踪合约的非对账状态；逐合约判定，不跨合约互抵，等式本身不作证明。
- `src/server/dealGates.ts`（由deals.ts抽出，含19冲突门）：任何用途的开仓腿落在跟踪合约上时新鲜读持仓对账，UNKNOWN即409`contract-unreconciled`并写告警（在途除外），减仓与对冲不受此门；`slice:{id}`只允许`reduce`；设杠杆前新鲜读持仓，校验切片可减量与账户可减量（|持仓|−未完成减仓占用）；写入前同步复查；deal与`deal_slice`同一保存点写入。`livePositions.ts`：持仓以`positionSide`为准、同合约多行相加，不可读即报错。`routes/slices.ts`：`GET /api/slices`（切片、可减、各跟踪合约新鲜对账并为差异写告警，读失败为UNKNOWN非0）；`POST /api/slices/recover`仅接受与服务器当下读数一致的`observedActual`，只写账。

## 审查

双轴审查。规格轴：未接入阻断新增风险（已加开仓对账门）；差异未记录（已写告警，恢复写`external`动账）；无UNKNOWN标记（已加`unknown`）；空的反向切片可共存且净额掩盖双向（已在attach复查并在对账中判over-attributed）；DONE后崩溃会丢成交（已加启动/claim/recover前补记，并以基线时间排除更早deal）；持仓忽略`positionSide`、同合约多行覆盖（已统一读取）；已有成交的deal可挂切片（已拒绝）。HALTED仍算在途（可能继续慢速对冲，期间开仓被对账门阻断，不放行风险）。标准轴：恢复由路由写账——已在architecture.md写明切片命令与deal命令同型、engine只写成交派生量；查询拆至`slice-queries.ts`、成交求和/告警类型/动账参数/合约规范化/状态码去重。

## 验证

新测试：`tests/unit/slice-booking.test.ts`（14）、`slice-reconcile.test.ts`（13）、`slice-engine.test.ts`（2）、`live-positions.test.ts`（2）、`tests/server/slices.test.ts`（11）。覆盖验收表：两同向切片各1、指定其一减0.5；A实成0.4、B实成0.1但预留0.4；重复/迟到累计；部分平仓与dust；超额；并发减仓预留；他deal占用账户可减量；场外改仓与显式恢复（含读数变化拒绝）；归属超出实际；反向切片拒绝；4.03中0.36认领、3.67未归属；engine驱动maker→对冲→DONE记账且重启不重复。审查前默认`yarn verify`退出1（root 3442全过，web仅`App.setupOnce`既有偶发失败，`/tmp/ticket15-verify-fail.log`），build退出0。审查修复后tsc通过；root unit/server 155文件3450通过/8跳过；文件预算通过。

## 限制

- 两次读数相同不能证明其间无场外往返成交（快照固有限制）；仅基线后可解释性被检查。
- 基线依赖“建切片时合约无活动deal”；更早已结束deal的成交视为基线的一部分。
- 可解释净仓只计本engine的成交；同账户手工下单/其他程序成交均为场外差异。
- 切片收益/金额归因不在本票（04：数量账先行）；Risk适用由16、认领入口由17、开/加仓由12接入。
