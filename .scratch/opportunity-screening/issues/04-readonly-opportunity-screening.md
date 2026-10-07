# 实现单次只读投资机会筛选脚本

Parent: ../map.md
Label: ready-for-agent
Type: task
Status: ready-for-agent
Progress: unclaimed
Assignee: none
Blocked by: none

## Spec

依据 [单次只读投资机会筛选脚本规格](../spec.md) 实现 CLI、配套离线测试和使用说明。规格是本票的唯一验收主体，不复制详细决策或测试列表。

首版单次运行，默认每腿 $10,000、永续 limit + hedge、Boros 市价成交利率，平仓主榜与滚仓对照；输出 Markdown + JSON。仅查询 Opportunity API，缺证据保留 UNKNOWN，不读取账户保证金或四腿持仓。不修改 API，不执行交易或启动监控。

## Completion

- 完成规格的全部用户可见行为及 Testing Decisions 场景。
- 提供可运行命令、参数/退出码说明与合成双格式报告。
- 记录所运行的离线检查、结果与剩余证据限制；不保存实盘 fixture。
- 验证仅有 Opportunity GET 请求，不以模型资金或候选入选表述执行 ready。

## Comments

- 2026-10-07：按用户显式调用 to-spec 从现有对话综合并发布，直接标记 ready-for-agent，不重新进行需求访谈。之前的决策票保留历史，未被冒称已访谈解决或原型验收完成；它们不作为本实施票的阻塞依赖。
- 2026-10-07 用户确认测试高层边界符合预期：合成 API 响应至 Markdown/JSON 报告，验证筛选、账户范围、UNKNOWN 和只读约束；不执行实盘交易。详见规格 Testing Decisions。
- 2026-10-07 用户收窄范围：仅筛选 Opportunity，删除已有持仓关系与账户保证金/四腿持仓读取。保留合成响应到报告的测试边界，账户与持仓分析不再纳入验收。
