# 实现单次只读投资机会筛选脚本

Parent: ../map.md
Label: ready-for-agent
Type: task
Status: resolved
Progress: resolved
Assignee: implement_04
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

## Answer

- 2026-10-08 状态复核：维持 resolved。盘口失败诊断及三路并发连接保留修复已提交为 `575ae58`；榜外 roll 异常完整报告修复为 `227c755`，均已进入 `codex/opportunity-screening`。当前脚本 27 项离线测试通过；最新只读扫描 `20261008T005518-f47dbc261379` 为 VALID，Top 5，无对照异常。该扫描仅验证当次证据，不证明实盘执行准备，也不保证未来没有 UNKNOWN。01/03 同步关闭，02 维持 wontfix。

- 2026-10-07 用户要求解决代理超时根因：确认 Axios 隐式代理使用 v5 Agent，请求结束销毁 socket；公开行情改用独立的 `https-proxy-agent 7` keepAlive 连接池，同站点元数据与盘口复用隧道，保留 2.5 秒超时、TLS 校验与失败返回 null，没有重试或更改签名 Gate 客户端。真实本机 HTTPS/CONNECT 回归修复前 7 条隧道、修复后按三个目标站仅 3 条，额外验证未信任证书拒绝。只读实测 Gate 复用后 130～149ms、Binance 127ms、Hyperliquid 133～174ms；首次建连仍可能超时。完整 `yarn verify` 与生产构建通过；未重启用户服务。

- 2026-10-07 用户要求统一代理：修复公开永续盘口采集仅 Gate 使用 `GATE_PROXY` 的问题，所有交易所盘口 GET/POST 及合约元数据、市场发现查询复用该配置。7 项网络边界回归场景修复前 6 失败、修复后全部通过；相关 113 项测试和 25 项脚本测试通过。只读实测 Binance ETH/BTC 各买卖 100 档，Gate ETH、Lighter ETH/BTC、Bybit HYPE 也取得盘口。代理失败仍返回缺失证据，不直连回退；本机筛选请求不经代理。没有重启用户服务，需重新加载代码后生效。

- 2026-10-07 用户后续批准最小 API 扩展：Opportunity 的 `data.meta.freshness` 新增 `marketData/staticData`，各自汇总 observedAt 与 stale，原聚合元数据、缓存 TTL 和收益模型不变。脚本行情上限默认 180 秒、静态默认 600 秒，`--max-age` 保留为行情别名，close/roll 偏差比较行情时间；旧服务缺分类字段仍 UNKNOWN。25 项脚本测试、75 项相关接口/模型测试、全仓 `yarn verify`（2588 服务端/单元通过、1456 UI 通过）、生产构建及差异检查全部通过。合成有效示例包含行情 10 秒/静态 339 秒且 VALID。只读检查确认当前服务尚未加载字段；没有重启服务，需重新加载代码后生效。

- 2026-10-07 后续修复：已知缺合约组告警按市场关联，忽略候选未使用市场的告警；未知/整组告警仍 UNKNOWN。拆分 maker 与到期错误，排除项新增组合身份、缺失字段和固定盘口/费率原因，Markdown 合并相同 close/roll 项。21 项离线测试通过，包含误伤复现和敏感文本不落盘。相同只读命令实测生成 `20261007T213103-8ba84c9747f0`；组级误伤与误导性到期原因消失，本次因实际观察年龄超 180 秒及部分永续盘口不可用保持 UNKNOWN。未修改原报告或服务端，未放宽证据门槛。

- 2026-10-07：交付 `scripts/opportunity_screening.py`，仅双次 Opportunity GET；本机传输、完整证据准入、close/roll 匹配、稳定 Top 排序与 UNKNOWN 降级均由单次公开运行边界验证。没有实盘、凭据查询、服务启动或 API 修改。
- 使用说明：`docs/OPPORTUNITY-SCREENING.zh-CN.md`；合成有效/降级双格式示例：`docs/examples/opportunity-screening/`。
- TDD 先验证缺脚本失败，再实现有效报告；随后以假设费率参考、畸形嵌套证据、错误类型规模与凭据嵌入标签逐次 red/green。`python3 -m unittest discover -s tests/screening -v`：16 测试通过，含多组参数化场景。`python3 -m py_compile scripts/opportunity_screening.py` 通过。
- 集成前父代理基线检查：`yarn verify`、`yarn typecheck`、`yarn --cwd web build` 全通过；首次沙箱内 verify 的子进程 EPERM 在沙箱外重跑解决，日志 `/tmp/opportunity-screening-verify.log`。本票未修改 TypeScript/UI。
- 证据限制：使用既有 API 聚合 observedAt/stale 与文字 warning，未独立验证逐项上游费用来源；warning 保守降级。盘口与模型资金不代表四腿执行准备，未计 Gas/借款利息等成本，未叠加客户端返费。

- 2026-10-07 集成代码审查修正两项 P2：巨型 JSON 整数及持有期收益除法溢出现在写 UNKNOWN 降级报告并退出 2；close/roll makerLeg 不同保留有效 close 主榜，对照明确 maker leg mismatch/UNKNOWN 并退出 2。两项均先通过公开运行边界观察失败，再修正；`python3 -m unittest discover -s tests/screening -v` 现 18 测试全部通过，`python3 -m py_compile scripts/opportunity_screening.py` 与 `git diff --check` 通过。既有合成示例行为不变，未修改样例。
