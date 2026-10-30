# Ticket 21 Spec review

固定比较：`git diff 9728a455b88cb8e69d7b60cc9e234bb4d997a205...HEAD`；审查提交 `2ea469e`。只读审查，未重跑完整gate或live测试。

## 结论

未发现需要修改的Spec缺陷：未完成/部分需求0项；越界0项；看似实现但错误0项。本票交付边界是隔离技术验收与人工启用准备，不是生产能力全部获证或实际启用。

## 核实依据

- 主票第14行要求“逐项绑定实现提交、测试文件/命令/退出状态及浏览器证据，保留失败与修复记录”。`21-acceptance-matrix.md:11-24`覆盖实施矩阵全部14行，`21-validation.json:8-62`记录标准gate、build、Python及新增组合命令/退出码/hash；`21-failure-history.md:7-28`保留夹具失败、认证负例和修补。生产`src/`、`web/src/`对基线确实无diff。
- 主票第17行要求“保证至多一个执行且无页面补单”。`tests/server/funding-integrated-readiness.test.ts:16-54`串联正式候选/preview/接受并发/关入口/真实fake-venue部分成交/Stop/逐量slice；第57-80行验证重读跨10秒与UTC旧时间；第83-114行验证unknown/取消未确认冻结与恢复；第117-142行验证原到期转换及每tick至多一wire。
- 主票第19行要求“一致备份/失败恢复、版本拒绝、不兼容旧程序回退、已有新写入禁止旧备份覆盖”。`tests/server/funding-ledger-lifecycle.test.ts:37-85,88-109`串联旧账保护、活动升级拒绝、闭门新交易、新写入后拒绝restore、旧程序拒绝及无新写入恢复；其余schema/FK等边界由矩阵第23行列出的既有unit/server回归承担。
- 主票第24行要求“正式A页实际检查保留四腿/三腿入口及完整交互”。最终`21-browser-runs/2026-10-30T00-11-19-791Z/evidence.json`实际有14步；驱动第56-135行覆盖6项401、编辑/短按零提交、409新preview重确认、202响应截断、刷新只查询、0.05部分成交与独立Stop、Positions/Risk、三腿/四腿两个向导和stale。原始记录终态为1 deal、2 create、admission关闭。父agent另实际查看该run的重确认、Positions、部分成交及两个原向导5张关键图。

## 保留边界（不是静默豁免或PASS）

主票第28-30行明确保留“真实Retry-After/429/418…未公开实测”“共享IP…无法…推导”及“不证明全年分页、历史周期/上市/HL结算映射、完整来源能力或开仓准入”。矩阵第11/30行和runbook第15-18行仍明确UNKNOWN，包括经济单位、HYPE、跨实例/重启与PowerShell运行时未验。0.05浏览器夹具没有冒充4.03/0.36/3.67等全部策略证明，后者归于矩阵第21行的TS/Python数量回归。

主票第20行要求“观察阶段和完整人工阶段分开签收…用户另行明确启用”。runbook第3/20-26行保留两阶段用户签收和实际授权PENDING，因此其未发生不是本次技术交付缺陷；只能报告“可申请人工启用”。

## 交接

目标为检查21最终集成票对主票、实施矩阵与规格的符合性；已审固定基线至2ea469e的组合测试、隔离浏览器桥及验收文档。没有代码修改或生产操作。确认6条组合用例与14步Chrome原始记录能支撑限定的技术结论，既有全量门禁结果未被单跑替代。未发现Spec需修项；现场历史规则、限流、经济单位、跨实例/重启、Windows运行时等已列限制继续保留。后续由父agent汇总Standards轴后交用户，两阶段人工签收及实际启用仍待明确授权。证据主索引为21-acceptance-matrix.md、21-validation.json；本报告路径为/tmp/issue21-review-spec.md。

## be46437 定点复审

比较 `git diff 2ea469e...be46437`，未发现新增Spec问题。唯一行为修改为`21-browser-server.ts:42`的合成position_value以`fxStr(fx(p.positionQty) * 2500n)`替代浮点运算；2500是无小数整数单价，乘法保留fx固定精度单位，输出仍为十进制字符串，符合规格第52行金额/数量约束，没有改变数量、费用、时钟、期限或执行行为。其余改动为复验/文档记录，未扩大生产支持范围。

最终run更新为`21-browser-runs/2026-10-30T00-14-55-853Z/`。实际解析新JSON确认14步passed、6项401、409后202且responseDropped=true、最终1 deal/2 create/admission=false；evidenceHash、全部harnessSources与checks日志SHA-256均一致。父agent已重新查看新run的Positions和partial关键图。strict类型检查/浏览器退出0有新日志，生产和已验证测试源码未改，保留原完整gate合理。Spec缺陷计数仍为0；上一段审查中的旧run只作历史证据，新目录为最终依据。
