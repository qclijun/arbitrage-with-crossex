# 投资机会筛选脚本工作地图

Label: wayfinder:map
Status: open
Updated: 2026-10-07 Asia/Taipei

## Destination

依据 [机会筛选原则](../../docs/OPPORTUNITY-SELECTION.zh-CN.md) 的机会比较部分，交付可手动运行一次的只读脚本，仅查询 Opportunity API，筛选收益候选 Top 5，保存 Markdown 与 JSON。无法验证的数据保留 UNKNOWN，不读取账户保证金或四腿持仓。

## Notes

- 用户明确要求编写脚本，执行交付纳入本地图范围；本轮按 wayfinder 先绘制地图，尚未交付脚本。后续逐票形成决策，不能以地图代替实现完成。
- 使用 wayfinder、grilling、domain-modeling；结构查询使用 codebase-memory。本地 tracker 规则见 [工单约定](../../docs/agents/issue-tracker.md)。
- 用户已确认：单次只读扫描；同时生成 Markdown 与 JSON；不设固定最低净利润门槛。上述约束是用户输入，详细行为在子议题中定案。
- 不下单、不转账、不调整保证金、不启动监控、不发送通知，不重启现有终端服务。
- 复用当前终端 Opportunity 的已有收益计算，不另建独立行情采集器，不沿用历史机会排名；不额外查询账户数据。
- 初步扫描基准为每腿 $10,000、limit + hedge、平仓主口径并对照滚仓；目标规模应可配置。此为原则文档基准，不是安全仓位建议。
- 严格保留 UNKNOWN，不能因请求成功、盘口 ok 或必要资金条件满足就报告执行 ready。
- 用户已确认：首版仅编写脚本，复用现有 Opportunity 接口；新鲜度或收益数据完整性不足时输出 UNKNOWN。终端 API 字段补充留待后续单独工作。
- 子议题按编号查询；只有依赖全部 resolved 的 open/unclaimed 子议题可以认领。认领时写入 Assignee 和 claimed，结论追加 Answer，完成后写 resolved。
- 既有可复用点：`GET /api/opportunities` 已有收益计算。仅取其平仓和滚仓结果，历史核查中的其他账户接口不纳入当前实现。
- 本轮只读事实核查见 [现有终端数据与脚本复用边界](evidence/source-review.md)，该报告是决策输入，未关闭任何决策票。
- 2026-10-07 用户调用 to-spec，已从对话综合发布 [实施规格](spec.md) 和 [实现单次只读投资机会筛选脚本](issues/04-readonly-opportunity-screening.md)，标记 ready-for-agent。后续实现以该规格为准，先前决策票保留历史，不要求重新访谈或先关闭它们；脚本尚未实现。
- 2026-10-07 用户简化范围为仅筛选 Opportunity，已同步规格与实施票；已有持仓和账户分析议题关闭为范围外，不表示曾实现。

## Decisions so far

尚未关闭决策票。本轮的用户输入保存在对应子议题 Comments 中，不冒充已验证的数据或已交付实现。

## Not yet specified

- Opportunity 数据契约核查后可能暴露的特殊抵押品或合约报价关系，待其实际形态明确后再判断是否需要新增决策票。
- 报告原型反馈可能暴露的阅读和解释需求，待原型讨论后再细化。

## Out of scope

- 读取账户保证金、四腿持仓、钱包、独立费率及返费；账户适用性、原仓复用、续作和换仓分析。[已有持仓下的账户结论](issues/02-account-selection-contract.md) 因用户明确缩小范围而关闭，保留原始问题和历史。
- 自动交易、资金划转、自动展期、通知和后台定时运行。
- 用固定安全 APR 或统一保证金倍数自动决定仓位分配。
- 将候选榜当成必须买满五个的投资组合，或宣称模型保证收益。
- 重写服务端已有收益计算、直接连接交易所另建采集系统。
- 首版修改终端 API 或新增证据字段；缺口仅记录并降级。
- 原子展期完整执行准备评估；已有独立 [原子展期风险监控地图](../rollover-risk-monitoring/map.md)，筛选只引用能够核验的证据，不替代该工作。

## Delivered

- 2026-10-07：[实施票 04](issues/04-readonly-opportunity-screening.md) resolved；交付单次只读 CLI、16 个公开运行边界离线测试及合成双格式示例。用法见 [说明](../../docs/OPPORTUNITY-SCREENING.zh-CN.md)。历史决策票 01/03 保留历史，不代表已完成访谈或原型；02 维持范围外。集成分支审查仍由 implement-spec 工作流完成。
