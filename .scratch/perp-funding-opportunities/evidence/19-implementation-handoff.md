# 工单19实施交接

目标：06-Q1/Q3/Q5服务端准入边界。用户确认接缝（2026-10-28）：开关存SQLite（20协议v2附加步骤），默认/无记录/版本不符即关闭，只管永续两腿机会新开（12接受协议），每次开关递增代次、接受时同事务核对；独立PairTicket/SingleTicket新开仅在涉及合约无持仓、无活动deal、无挂单时允许；四腿/三腿以`purpose='boros-strategy'`＋Boros上下文选择原行为、不给特权；旧客户端开仓明确报错、平仓照常。

## 交付

- `src/engine/ledger/version.ts`步骤2（不要求收敛）：`pair.purpose`/`purpose_context`及`admission_switch`单行表；旧deal读作purpose NULL继续执行。`ledger-support.json`→2。
- `src/engine/admission.ts` `AdmissionSwitch`（`store.admission`）：`read()`仅在有记录、open且启用时程序版本＝当前`version.json`版本、账本版本＝`LEDGER_VERSION`时为开，否则`never-enabled`/`closed`/`version-changed`/`version-unknown`；`enable`/`disable`各递增代次（程序不知自身版本时拒绝启用）；`admit(generation, write)`在同一`BEGIN IMMEDIATE`内核对开且代次一致后执行写入，否则不执行并返回状态，写入抛错整体回滚。关闭后迟到请求与重开后的旧代次均被拒。12须经此原子入口接受意图，不另建协议。
- `src/server/routes/admission.ts`：`GET/POST /api/admission`（`{"open":bool}`），只写开关：不停deal、不wake、不调venue；无UI，不代用户启用。
- `src/server/dealPurpose.ts`＋`routes/deals.ts`：在读取任何场所数据前分类。全部腿reduceOnly→`reduce`（旧客户端亦可；实时持仓校验仍在`resolveDeal`，标签不自证）；增加风险而无purpose→400`client-outdated`；`reduce`标签配开仓腿或反之→`purpose-mismatch`；`funding-two-leg`→409`funding-admission-required`（永不经/deals降级）；未知→`purpose-unknown`；`boros-strategy`须`boros:{base,venues[1-2],maturity?,marketIds?,route?}`且base一致、maturity在未来。偏离用户原选项一处：并非所有入口知道Boros市场id/到期（向导到期可选、缺口修复只知venue），故必填base＋venues，其余有则校验；标签仍只选择原有行为，不给Risk/归属特权。
- `src/server/manualConflicts.ts`：`manual`对增加风险的腿合约先查store活动deal（同步），再新鲜读取持仓与venue挂单（不经缓存）；有持仓（归属未证）、活动deal或挂单→409`manual-conflict`，读取失败→503`manual-unverifiable`；均在设置杠杆前。杠杆阶段后、写入前无await地再查活动deal，期间新启动的deal→恢复杠杆并拒绝。purpose与上下文随deal持久化。
- web：`ExecuteControl`必填`purpose`，全部reduceOnly的deal自动声明`reduce`；`PairTicket`/`SingleTicket`由策略预填的Boros上下文（仍在同一币种）声明`boros-strategy`，否则`manual`（`trade/purpose.ts`）；`StrategyWizard`及资产卡缺口/Boros-only补腿预填携带上下文；平仓表单声明`reduce`。

## 验证

新测试：`tests/unit/admission-switch.test.ts`（7）、`tests/unit/deal-purpose.test.ts`（15）、`tests/server/deals-purpose.test.ts`（12）、`tests/server/admission.test.ts`（6）、`web/src/trade/purpose.test.ts`（2）；`ledger-version`增加v1带活动deal升级v2不拒绝。既有deal测试负载改为`boros-strategy`（保持原行为），PairTicket/ExecuteControl断言purpose。tsc（root/web）通过；root unit/server 150文件3406通过/8跳过；web trade/assets等43文件656通过；文件预算通过。

## 限制

- 机会入口及其预览/接受协议由12实现；本票之后`funding-two-leg`在/deals恒拒绝，开关开启本身不开放任何入口。
- `manual`冲突门只看实时持仓/挂单/活动deal，不证明未来15切片归属；独立开仓成交为未归属。读取与写入之间的场所侧外部变化（他处下单）无法排除。
- 杠杆仍由路由直接设置（既有差异，12负责移交engine）；冲突在杠杆前拒绝，仅写入前竞态会设置后恢复。
- 已接受执行在开关关闭后照原确认继续（测试覆盖maker成交→对冲→DONE）；逐单Stop等既有控制不变。
