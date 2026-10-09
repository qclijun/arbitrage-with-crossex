# 什么报告与退出语义能让筛选结果可核查

Parent: ../map.md
Label: wayfinder:prototype
Type: prototype
Mode: HITL
Status: resolved
Triage: ready-for-agent
Progress: resolved
Assignee: root
Blocked by: none

## Question

怎样设计单次 CLI 的 Markdown 与 JSON 报告，使用户能同时理解收益候选、持仓约束、UNKNOWN 和成本假设？通过便宜的合成报告原型确认字段、错误语义和最小验收范围，再决定正式实现的接口。

需要回答的具体分支：

- CLI 参数、默认本机地址、名义本金、Top 数量、主退出口径及输出路径；是否需要离线输入快照模式。
- JSON 字段与 Markdown 一致，金额、APR fraction/百分比、时间单位和账户脱敏方式明确。
- 有候选、零合格候选、部分数据、身份改变、服务不可用分别怎样报告与设置退出码；零候选不等于脚本失败，也不等于所有机会安全。
- 本机报告包含私有资金数据：默认不保存原始接口响应，不泄漏认证 token/完整身份，文档和离线 fixtures 不使用实盘账户数据。
- 两个报告同一运行标识；写入失败或部分写入如何报告，避免旧文件被误认为本次结果。
- 合成场景覆盖正收益、负收益、短期成本、缺盘口、NaN/null、陈旧/未来时间、范围错配、保证金不足、已有仓位不能重复复用、缺换仓成本和不足五个候选。
- 只读验证 GET 白名单及无启动/通知/交易副作用；具体实现的检查命令和停止条件。

## Comments

- 2026-10-07 用户选择：单次只读扫描；Markdown + JSON。
- 原型只使用合成数据，不查询实盘或执行交易。资产链接应追加在本票，不在地图正文存放详细样稿。
- 本票解决报告设计及验收范围，尚未制作原型或交付脚本。

- 2026-10-08：按用户要求更新状态。后续确认的规格及正式交付取代早期原型讨论；原始内容与初始 needs-info 分诊保留为历史。01 已解决，02 的账户分析被移出范围，不再作为阻塞依赖。

## Answer

- 当前范围的 CLI 参数、单位、双格式报告、唯一运行目录、权限、退出码、零候选及部分结果语义均已交付，见[使用说明](../../../docs/OPPORTUNITY-SCREENING.zh-CN.md)。合成样例：[有效 Markdown](../../../docs/examples/opportunity-screening/valid.md)、[有效 JSON](../../../docs/examples/opportunity-screening/valid.json)、[降级 Markdown](../../../docs/examples/opportunity-screening/unknown.md)、[降级 JSON](../../../docs/examples/opportunity-screening/unknown.json)。
- 27 项合成响应至报告的测试通过。后续修复保证榜外合格候选的 roll 异常也进入 `comparisonIssues` 和 Markdown，避免整体 UNKNOWN 没有可见原因；Top 数量和排序不变。
- 持仓、保证金及换仓成本场景已移出范围，不宣称已实现账户报告或完成独立原型访谈。当前范围的报告设计已由正式实现和行为验证覆盖，关闭为 resolved。
