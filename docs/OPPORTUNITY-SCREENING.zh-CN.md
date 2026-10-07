# 单次 Opportunity 收益候选筛选

脚本只消费当前终端的 Opportunity 计算，分别查询平仓与滚仓，生成最多五个收益候选。它不读取账户、持仓、钱包或保证金，也不下单、通知、启动监控或启动服务。运行前终端需已由用户启动；离线测试仅使用合成数据，不执行交易。

```sh
python3 scripts/opportunity_screening.py \
  --url http://127.0.0.1:6688 \
  --token-file /path/to/api-token \
  --notional 10000 --top 5 \
  --output-dir data/opportunity-screening
```

无需额外 Python 包；使用支持 `zoneinfo` 的 Python 3.9+。token 仅从文件读取，不能作为明文命令行参数传入。先验证本机 URL，再读取 token；仅允许 loopback origin，不接受 URL 内认证、路径、查询或片段。localhost 固定到 127.0.0.1，环境代理关闭，重定向拒绝。仅发送两次 GET `/api/opportunities`，各带 `entryMode=maker-hedge`、`borosEntry=market`、`exitMode=close/roll` 和规模；不另建行情采集器。

| 参数 | 默认值 | 含义 |
|---|---|---|
| `--url` | `http://127.0.0.1:6688` | 终端 loopback origin |
| `--token-file` | `api-token` | 本机鉴权文件；不写入报告 |
| `--notional` | `10000` | 每腿 USD 名义本金 |
| `--top` | `5` | 最多展示数量；不足不补齐 |
| `--output-dir` | `data/opportunity-screening` | 每次生成独立运行目录 |
| `--max-market-age` / `--max-age` | `180` | 最大行情观察与构建年龄，秒；旧参数保留为别名 |
| `--max-static-age` | `600` | 最大手续费、合约规则和杠杆限制观察年龄，秒 |
| `--max-skew` | `120` | close/roll 行情观察时间偏差上限，秒 |
| `--timeout` | `20` | 每次请求超时，秒 |

金额以 USD 数值保存；JSON APR 为 decimal fraction（`0.05` = 5%），Markdown 为百分比。时间以 Asia/Taipei 展示，输入观察时间 JSON 字段为 Unix 毫秒。每次输出来自同一规范化结果的 `report.json` 与 `report.md`；运行目录权限 0700、文件 0600。不会覆盖旧运行。写入失败可能留下不完整目录；退出码 1，不宣称双格式完成。

| 退出码 | 含义 |
|---|---|
| `0` | 完整有效扫描，包含零候选和正常过滤非正利润 |
| `2` | UNKNOWN、关键证据缺失或部分结果；保存降级报告 |
| `1` | 参数/鉴权错误、无法开始采集或写入失败 |

主榜要求对应永续合约、两腿目标规模 book ok、执行利率、完整费用与模型资金、正期限和正净利润；不使用 null、非有限数、布尔或错误类型。排序先按模型资金净年化，再按名义本金净年化、执行利差，最后稳定组合身份。API 的利润、成本与资金直接保留，脚本只推导持有期收益 `estProfitUsd / capitalUsd` 和使净利润归零的额外成本。

close/roll 按标的、抵押品、到期、市场及方向匹配，验证规模和入场设置、credentialId（若提供）和观察偏差。滚仓缺失或错配保留独立有效主榜，对照为 UNKNOWN。陈旧、未来、缺观察时间、API 降级 warning 或不完整证据不进入主榜。响应 `ts` 不能替代观察时间。API 的假设费率 warning 对应金额只保留为 UNKNOWN 参考，不进入实际费率榜；原始 warning/reason 不写入文件，使用固定原因且额外遮蔽实际 token/credentialId。

模型资金只是收益分母，不能视作实际账户余额、安全预算或执行就绪。maker 成本假设挂单按 mid 成交，入场和模型 maker 退出均不保证成交；book ok 不证明四腿均能成交，OI 仅为市场规模参考。Boros 冲击已含在执行利率，不能再次扣除。未叠加客户端返费；Gas、借款利息及模型未涵盖成本不在结果内。滚仓只省去本期永续退出成本，最终退出仍可能付费，也不保证后续机会。

API 提供聚合及分类观察时间，费用来源仍通过文字 warning 表达，没有逐项上游费率证据。无 warning 仅表示现有 API 未声明假设费率，不证明完整执行准备或独立核验每个费用来源。异常 warning 统一保守降级。

分类新鲜度检查使用 Opportunity 返回的 `data.meta.freshness.marketData` 与 `staticData`，每类含 Unix 毫秒 `observedAt` 和明确布尔 `stale`，取该类已获取输入中的最旧时刻，stale 为该类输入状态的并集；整类无法取得观察时间则为 null。行情包括 Boros 市场/盘口与永续盘口，静态数据包括手续费、合约规则及杠杆限制。两类分别检查缺失、未来、陈旧及超龄；聚合时间只核对一致性，不再按 180 秒统一拒绝。报告分别展示观察时间、年龄、上限和状态。旧服务没有这些字段时，两类均为 UNKNOWN，脚本不会把构建时间或聚合时间猜作分类证据。2026-10-07 用户已批准仅新增分类元数据，不改变缓存频率或收益模型；正在运行的旧服务需重新加载代码后才能返回新字段，脚本不会自动重启服务。

组级告警按市场关联：已知的缺 CrossEx 合约告警只影响使用该市场的候选，不会排除同组其他完整组合；无法识别或影响整组的告警仍降级 UNKNOWN。排除项包含标的、抵押品、到期、两侧市场及合约、缺失/无效字段，并将 API 已知的盘口或费率原因转换为固定说明，不保存原始文本。缺少 maker 腿与到期证据分别说明。JSON 保留 close/roll 各自结果，Markdown 合并内容完全相同的排除记录并标明两种口径。

整体数据状态覆盖所有候选，包括未进入 Top 榜的合格候选。任何 roll 对照异常都会保存到 JSON 的 `comparisonIssues` 并在 Markdown 的 `Roll comparison issues` 中显示组合身份、排名、是否在 Top 榜和原因；Top 榜数量及排序不变。正常利润过滤仍记录在排除项中，不触发 UNKNOWN。

终端服务的公开交易所盘口、合约元数据和市场查询统一使用已有 `GATE_PROXY` 配置，例如 `.env` 中的 `GATE_PROXY=http://127.0.0.1:7899`。未配置时保留原有请求行为；代理失败仍视为缺失证据，不回退到另一条网络路径。脚本访问本机终端仍关闭环境代理。修改服务代码或配置后需重新加载终端服务。

公开行情通过支持 keepAlive 的代理连接池按目标站复用 HTTPS 隧道，元数据与盘口共享连接；切换代理配置会关闭旧连接池。单次请求仍为 2.5 秒超时，没有新增重试或后台采集，也不改变签名交易客户端。首次连接、连接被上游关闭或网络中断后仍需重新握手，可能超时并产生 UNKNOWN；连接复用只减少重复建连开销，不保证每次请求成功。

盘口失败的 HTTP 状态码、采集耗时、错误类别、阶段及观察时间由 `data.meta.venueBookFailures` 提供，脚本保存到两种报告。未取得 HTTP 状态时明确显示未记录，不把它猜作 HTTP 错误；详见[盘口失败诊断](venue-book-diagnostics.md)。新字段需要终端服务加载更新后的代码，历史报告无法补回这些信息。

合成示例：[有效报告](examples/opportunity-screening/valid.md)、[JSON](examples/opportunity-screening/valid.json)；[降级报告](examples/opportunity-screening/unknown.md)、[JSON](examples/opportunity-screening/unknown.json)。示例全部来自固定时钟和虚构 API 响应，金额仅用于演示，不代表当前市场。

离线检查：

```sh
python3 -m unittest discover -s tests/screening -v
```
