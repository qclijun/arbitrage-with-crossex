# 生产历史源、结算规则与采集预算研究

Type: research
Status: resolved
Assignee: Codex
Blocked by: none

## Question

针对CrossEx实际支持的live永续，各场所哪些官方生产来源能证明[历史契约](../history-and-eligibility.md)要求的已结算事件、周期变化和覆盖？不把当前bulk feed或离线六场所研究读取器当成完整生产历史服务。

## 工作范围

- 按当前八场所候选BINANCE/ASTER/OKX/BYBIT/GATE/HYPERLIQUID/KRAKEN/LIGHTER核查，实际观察集合仍以CrossEx live合约为准。各场所分别引用官方文档/接口证据、查询日期与限制，不预设全部可用。
- 查明已结算与预测值区分、事件唯一性、时间边界、分页/截断、保留期、上市时间、周期与历史变更依据、修订/冲突语义。
- 查明请求限流/权重、可用批量查询、鉴权需求及延迟，为15分钟内刷新目标提出有界请求数、并发、超时和重试预算；不能满足时明确缺口，不降低完整性门槛。
- 只读研究；不读账户凭据、不启动服务、不交易。示例采用公开/合成数据，不提交实盘账户记录。

## Acceptance

逐场所给出verified/unknown/unsupported能力矩阵、来源URL与取证日期；unknown和unsupported必须区分。至少覆盖周期变化、分页失败和新币缺历史的证明方案，列出仍不能证明的字段。报告保存evidence并链接Answer；必要时再拆具体场所研究票，不承诺八场所全量历史。

## Comments

- 2026-10-27：由01已确认决定拆出；01已resolved，本票可研究，不代表08/09已获实施准入。

## Answer

2026-10-27 完成八场所官方公开来源核查，逐场所的 verified/unknown/unsupported 能力、接口边界、分页与限流、15 分钟预算初值及失败证明方案见[研究证据](../evidence/history-source-research.md)。已证实可取历史记录不代表可证明某 live 合约的完整窗口；历史周期生效时间、上市起点和若干接口的终止/修订语义仍为 unknown。OKX 普通历史端点仅覆盖近三个月，180/365 天由该端点不支持；Kraken 的 CSV 不能直接证明 15 分钟增量刷新。08/09 继续依赖 06 的实施准入，并按证据保留 UNKNOWN，不承诺八场所全量历史。
