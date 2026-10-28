# 工单19实施交接

目标：06-Q1/Q3/Q5服务端准入边界。用户确认接缝（2026-10-28）：开关存SQLite（20协议v2附加步骤），默认/无记录/版本不符即关闭，只管永续两腿机会新开（12接受协议），每次开关递增代次、接受时同事务核对；独立PairTicket/SingleTicket新开仅在涉及合约无持仓、无活动deal、无挂单时允许；四腿/三腿以`purpose='boros-strategy'`＋Boros上下文选择原行为、不给特权；旧客户端开仓明确报错、平仓照常。

## 交付

- `src/engine/ledger/version.ts`步骤2（不要求收敛）：`pair.purpose`/`purpose_context`及`admission_switch`单行表；旧deal读作purpose NULL继续执行。`ledger-support.json`→2。
- `src/engine/admission.ts` `AdmissionSwitch`（`store.admission`）：`read()`仅在有记录、open且启用时程序身份＝当前构建（`version.json`版本，安装版另加`install-info.json`提交）、账本版本＝`LEDGER_VERSION`时为开，否则`never-enabled`/`closed`/`version-changed`/`version-unknown`；`enable`/`disable`各递增代次（程序不知自身版本时拒绝启用）；`admit(generation, write)`在同一`BEGIN IMMEDIATE`内核对开且代次一致后执行写入，否则不执行并返回状态，写入抛错整体回滚。关闭后迟到请求与重开后的旧代次均被拒。12须经此原子入口接受意图，不另建协议。
- `src/server/routes/admission.ts`：`GET/POST /api/admission`（`{"open":bool}`），只写开关：不停deal、不wake、不调venue；无UI，不代用户启用。
- `src/server/dealPurpose.ts`＋`routes/deals.ts`：在读取任何场所数据前分类。全部腿reduceOnly→`reduce`（旧客户端亦可；实时持仓校验仍在`resolveDeal`，标签不自证）；增加风险而无purpose→400`client-outdated`；`reduce`标签配开仓腿或反之→`purpose-mismatch`；`funding-two-leg`→409`funding-admission-required`（永不经/deals降级）；未知→`purpose-unknown`；`boros-strategy`须`boros:{base,venues[1-2],maturity?,marketIds?,route?}`且base一致（maturity只需为正整数：修复可能指向已到期仓）。偏离用户原选项一处：并非所有入口知道Boros市场id/到期（向导到期可选、缺口修复只知venue），故必填base＋venues，其余有则校验；标签仍只选择原有行为，不给Risk/归属特权。
- `src/server/manualConflicts.ts`：`manual`对增加风险的腿合约先查store活动deal（同步），再新鲜读取持仓与venue挂单（不经缓存）；有持仓（归属未证；数量不可解析视为持有）、活动deal或挂单→409`manual-conflict`，读取失败或返回非列表→503`manual-unverifiable`（category network）；均在设置杠杆前。杠杆阶段后、写入前无await地再查活动deal，期间新启动的deal→恢复杠杆并拒绝。purpose与上下文随deal持久化。
- web：`ExecuteControl`必填`purpose`，全部reduceOnly的deal自动声明`reduce`；`PairTicket`/`SingleTicket`仅在仍是策略预填解析出的那组腿（合约及方向）时声明`boros-strategy`，换腿/换向/换币即`manual`（`trade/purpose.ts`）；`StrategyWizard`及资产卡缺口/Boros-only补腿预填携带上下文；平仓表单声明`reduce`。

## 审查

双轴审查。规格轴：策略预填后换腿仍带Boros上下文会绕过冲突门（已改为只认预填解析出的精确腿，补换腿测试）；仓位/挂单返回非列表被当作空（已改为不可读即拒绝）；到期须在未来会误拒到期仓修复（已放宽）；开关只绑`version.json`对未改版本号的热修无效（已加安装提交）；`admit`内不能再开事务（已注释）。标准轴：数量判零改用`fx`、503改network类别、`DEAL_PURPOSES`单一来源、`REDUCE_PURPOSE`/`borosContext`去重、`withPurpose`改名、恢复被插断的JSDoc。

未改（用户已定或判断项）：服务器不核实Boros仓/单（用户选择标签＋字段），故直接调用API伪造`boros-strategy`可跳过独立冲突门，所得仅为今天的原行为、无Risk/归属特权，16/15仍按实际证据；开关由路由直接写（与既有commands同型，无loop消费者故不wake）；“配置不明”按版本/开关记录理解，凭据缺失时12的取证读取本身失败拒绝；开/关与接受并发仅在单元层同步验证，12接受路由落地后补路由级。

## 验证

新测试：`tests/unit/admission-switch.test.ts`（7）、`tests/unit/deal-purpose.test.ts`（15）、`tests/server/deals-purpose.test.ts`（12）、`tests/server/admission.test.ts`（6）、`web/src/trade/purpose.test.ts`（2）；`ledger-version`增加v1带活动deal升级v2不拒绝。既有deal测试负载改为`boros-strategy`（保持原行为），PairTicket/ExecuteControl断言purpose。tsc（root/web）通过；root unit/server 150文件3406通过/8跳过；web trade/assets等43文件656通过；文件预算通过。

审查前默认`yarn verify`退出0（root 3406、web全过）、web build 0（`/tmp/ticket19-verify.log`）。审查修复后：root 150文件3408通过/8跳过；默认`yarn verify`退出1，web 2/1715失败——`App.setupOnce`（Settings对话框）与`PairTicket`远程重挂载5000ms超时，均为06起记录的同名偶发项，主机负载约17（`/tmp/ticket19-verify2-fail.log`）。诊断：两文件单跑两次27/27通过；该重挂载测试在基线d50199f独立worktree单跑3.72s、本票后3.78–3.80s，未变慢。build退出0。未改测试或配置，归21查因。

## 限制

- 机会入口及其预览/接受协议由12实现；本票之后`funding-two-leg`在/deals恒拒绝，开关开启本身不开放任何入口。
- `manual`冲突门只看实时持仓/挂单/活动deal，不证明未来15切片归属；独立开仓成交为未归属。读取与写入之间的场所侧外部变化（他处下单）无法排除。
- 杠杆仍由路由直接设置（既有差异，12负责移交engine）；冲突在杠杆前拒绝，仅写入前竞态会设置后恢复。
- 已接受执行在开关关闭后照原确认继续（测试覆盖maker成交→对冲→DONE）；逐单Stop等既有控制不变。
