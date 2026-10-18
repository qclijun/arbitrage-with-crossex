# Opportunity 筛选报告字段说明

这些字段描述：按目标规模入场后，组合预计能赚多少、需要多少模型资金，以及对应的收益率。

适用于 `report.json` 的 `candidates[]` 及其中有效的 `roll` 对照。`execApr` 位于 `shortLeg`、`longLeg` 内，其余字段位于组合对象内。

## 单位与计算口径

- 所有 APR 都是按年计算的小数：`0.10` 表示 **10%/年**。
- `holdingPeriodReturn` 也是小数，但表示整个剩余持有期的收益率，**未年化**。
- `Usd` 字段以美元计；`effectiveLeverage` 的单位是倍。
- `notionalUsd` 是**每腿**名义本金。下文公式中的分母采用该值，不是四腿名义规模之和。
- `null` 表示缺少可计算的证据，不等于零；相应结论应保留 UNKNOWN。

## 字段含义

下面的数值取自 2026-10-08 本机报告 `data/opportunity-screening/20261008T231956-bb8253886440/report.json` 的 `candidates[0]`。该报告每腿名义本金为 **$10,000**，示例是历史快照，不代表当前市场。

该历史示例使用修复前的保证金口径，未包含 CrossEx 的平仓费保证金预留；下表历史资金及相关收益率保留原值。当前报告按下文“平仓费保证金预留”说明计算，不应直接沿用这些历史资金收益率。

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `execApr` | 单条 Boros 腿按目标规模走盘口得到的加权成交年化利率。`shortLeg` 收取固定利率，`longLeg` 支付固定利率；不是永续合约的实时资金费率。 | short 收 **7.9885%**；long 付 **4.3900%** |
| `grossSpreadApr` | 两个 Boros 市场的中间利率差，尚未考虑目标规模的盘口冲击及费用。 | **4.1172%/年** |
| `execSpreadApr` | 两腿的成交利率差：`shortLeg.execApr − longLeg.execApr`。已考虑 Boros 盘口冲击，但尚未扣除模型费用和永续滑点等其他成本。 | **3.5985%/年** |
| `borosImpactApr` | Boros 盘口冲击使利差减少了多少：`grossSpreadApr − execSpreadApr`。已经体现在成交利差中，不再重复扣除。 | 减少 **0.5187 个百分点** |
| `capitalUsd` | 组合各腿的模型初始保证金之和：Boros 腿加两条永续腿；永续按场所最大杠杆计算，并包含每腿名义价值 0.075% 的平仓费保证金预留。不是实际账户余额或含额外安全缓冲的资金预算。 | **$991.53（旧口径历史值）** |
| `netFixedApr` | 扣除模型总成本后，以每腿名义本金为分母的净年化收益率。 | **2.6550%/年** |
| `netFixedAprOnCapital` | 同一笔预计净利润，以 `capitalUsd` 为分母的净年化收益率。这是筛选排名的首要指标。 | **26.7763%/年** |
| `effectiveLeverage` | `notionalUsd ÷ capitalUsd`，表示模型资金支撑的每腿名义规模倍数。不是实际设置的交易所杠杆，也不是四腿总敞口除以资金。 | **10.0854 倍** |
| `estProfitUsd` | 从入场持有到到期，扣除当前模型全部成本后的预计净利润。主榜采用到期平仓口径。 | **$56.27** |
| `holdingPeriodReturn` | 剩余整个持有期的模型资金收益率：`estProfitUsd ÷ capitalUsd`，未年化。 | **5.6752%** |
| `extraCostToZeroUsd` | 再增加多少未计成本会使预计净利润降至零：`max(0, estProfitUsd)`。不是保证损失上限。 | **$56.27** |
| `oiUsd` | 所选两侧 Boros 市场的未平仓名义规模折算美元，仅供市场规模参考。不是盘口可成交深度，也不是永续市场 OI。 | 约 **$607.41 万、$82.15 万** |

`oiUsd` 按组内 `markets` 的顺序筛选并收集，不能普遍将索引 0、1 固定解释为 short、long。该示例中两项依次对应 Hyperliquid Boros 市场 128、Binance Boros 市场 129。

## close 准入字段（2026-10-09 新增）

旧示例报告未包含以下字段；更新后的脚本仅在 close 有效候选和正常 FILTERED 项中保存，roll 对照不派生。

| 字段 | 含义 |
| --- | --- |
| `grossProfitUsd` | `grossSpreadApr × notionalUsd × secondsToMaturity / (365 × 86400)`；按中间利差计算的到期毛利润，未扣 Boros 盘口冲击和模型费用，不能用净利润加总成本替代。 |
| `friction` | `costs.totalUsd / grossProfitUsd`，JSON 为小数比例，0.4 = 40%。默认要求严格小于 0.4。毛利润非正时无定义，保存 `null`，该 close 被正常过滤。 |

另要求 `estProfitUsd > notionalUsd × minProfitRatio`，默认比例 0.001（0.1%）；每腿名义 $10,000 时净利润须严格大于 $10。两条门槛可配置，完整规则见[筛选说明](OPPORTUNITY-SCREENING.zh-CN.md#5-close-准入门槛与滚仓对照)。

## 字段之间的关系

令：

- `N = notionalUsd`：每腿名义本金。
- `T = secondsToMaturity / (365 × 86400)`：剩余期限，单位为年。
- `C = capitalUsd`：模型初始保证金合计。
- `K = costs.totalUsd`：当前退出口径下的模型总成本。
- `P = estProfitUsd`：预计净利润。

主要公式为：

```text
grossSpreadApr = short 市场 midApr − long 市场 midApr
execSpreadApr  = shortLeg.execApr − longLeg.execApr
borosImpactApr = grossSpreadApr − execSpreadApr

C = Boros 各腿初始保证金之和
  + capital.perpShortImUsd + capital.perpLongImUsd

P = N × T × execSpreadApr − K

netFixedApr          = P / (N × T)
netFixedAprOnCapital = P / (C × T)
effectiveLeverage   = N / C

netFixedAprOnCapital = netFixedApr × effectiveLeverage
holdingPeriodReturn = P / C = netFixedAprOnCapital × T
extraCostToZeroUsd  = max(0, P)
```

## 平仓费保证金预留

当前机会模型按 CrossEx 的规则计算每条永续腿：

```text
单腿永续初始保证金 = N / 该场所最大杠杆 + N × 0.00075
```

合成示例：每腿名义 $15,000，40 倍腿占用 $386.25，25 倍腿占用 $611.25；永续两腿合计 $997.50，比仅按杠杆计算的 $975.00 多 $22.50。Boros 保证金另行相加，普通四腿组合和三腿 Spread 采用同一规则。

0.075% 是保证金预留率，不是实际 Maker/Taker 成交费率。它只增加 `capitalUsd`，不增加 `costs.totalUsd`，也不再次扣减 `estProfitUsd`；资金年化、有效杠杆、持有期资金收益和排名使用修正后的资金分母。close 与 roll 均包含这项预留：roll 省略本期永续退出成本，仍需为继续持有的仓位保留保证金。最低模型资金仍未包含额外安全缓冲或备用金。

依据：[Gate 跨所账户规则说明——合约交易的保证金要求](https://www.gate.com/zh/help/crossex/functional/49325)。

## 如何理解示例

第一名剩余约 **77.36 天**。按 **$991.53** 的模型资金计算，预计净利润为 **$56.27**，持有期收益约 **5.68%**，折成年化约 **26.78%**。26.78% 是年化值，不是这 77.36 天预计赚取的比例。

模型资金只合计四腿初始保证金，不包含额外安全缓冲或备用金。实际投入更多保证金时，同一笔净利润对应的实际资金收益率会更低。

主榜 `close` 包含模型永续退出成本；`roll` 对照省去本期永续退出成本，因此预计利润和净年化可能更高，字段定义和分母规则不变。最终退出仍可能产生费用，未来滚仓机会也不保证存在。

模型未计入 Gas、借款利息等未建模成本；maker 成本假设按 mid 成交，挂单不保证成交。以上字段描述收益模型，不证明四腿执行准备完成。

## 实现依据

- [Opportunity 收益模型](../src/core/boros/opportunities.ts)：`buildMarketRow`、`buildPair`，负责成交利率、利差、成本、资金和净收益。
- [筛选脚本](../scripts/opportunity_screening.py)：`normalize`，派生持有期收益、额外成本归零门槛和报告内 OI 数组。
- [筛选脚本使用说明](OPPORTUNITY-SCREENING.zh-CN.md)。
