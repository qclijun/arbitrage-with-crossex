# 单次 Opportunity 收益候选筛选

脚本只消费当前终端的 Opportunity 计算，分别查询平仓与滚仓，生成最多五个收益候选。它不读取账户、持仓、钱包或保证金，也不下单、通知、启动监控或启动服务。运行前终端需已由用户启动；本次实现与验收未查询实盘。

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
| `--max-age` | `180` | 最大输入观察与构建年龄，秒 |
| `--max-skew` | `120` | close/roll 最旧输入观察时间偏差上限，秒 |
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

API 仅提供聚合观察时间和文字 warning，没有逐项上游费率证据。无 warning 仅表示现有 API 未声明假设费率，不证明完整执行准备或独立核验每个费用来源。异常 warning 统一保守降级，未来若 API 增加机器可读来源状态，可另行改进。

合成示例：[有效报告](examples/opportunity-screening/valid.md)、[JSON](examples/opportunity-screening/valid.json)；[降级报告](examples/opportunity-screening/unknown.md)、[JSON](examples/opportunity-screening/unknown.json)。示例全部来自固定时钟和虚构 API 响应，金额仅用于演示，不代表当前市场。

离线检查：

```sh
python3 -m unittest discover -s tests/screening -v
```
