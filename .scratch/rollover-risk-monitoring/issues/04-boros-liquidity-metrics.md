# 04: Boros Spread 与双边订单簿深度计算

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第一阶段：市场流动性
Progress: resolved
Blocked by: 03

## Problem

以公开 market 快照计算可比较的流动性指标；此阶段不依赖账户持仓、具体展期计划或完整批次模拟。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [x] 输出最佳 bid/ask APR、mid APR 和 Spread；采用 02 核验的 APR 方向定义公式，内部统一 APR fraction，页面用百分点（pp）或 APR bp（1 bp = 0.01 pp），不套用现货价差百分比。异常交叉盘口标记异常，不取绝对值掩盖问题。
- [x] 逐侧输出可见累计深度、档位数与最远 APR；注明这是已返回范围的可见深度，截断/分页不全不能声称全书总量。
- [x] 逐侧给出距各自最佳档位 10/25/50 APR bp 内的累计深度，明确端点包含、窗口定义和数量单位；这些是诊断窗口，不是交易滑点设置或协议边界。
- [x] 在官方换算可验证时同时展示 YU 与抵押资产数量，否则保留原生单位及 UNKNOWN 换算；不同 collateral/到期/venue 不直接相加。USD 转换仅在价格与时间可信时输出。
- [x] 完整零挂单的一侧可见深度为 0，其 best APR、mid/Spread 在不可计算时 UNKNOWN；缺失侧深度 UNKNOWN，不能补 0。负量/无效 APR/重复档位与不完整数据按契约处理。
- [x] 离线边界测试验证 APR 单位、方向、排序、档位累计、窗口端点、空/单边/交叉/截断盘口及量纲换算；市场成交量与 OI 直接使用已核验口径，不能由深度推算。

## Out of Scope

账户展期计划、四腿就绪/保证金结论、历史成交量与订单簿持久采集、自动展期及交易操作。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。

## Answer

2026-10-07：resolved。[纯指标模块](../../../src/core/boros/liquidity-metrics.ts) 通过现有 `GET /api/boros/liquidity` 的逐 market `metrics` 返回结果；[离线验收](../../../tests/server/boros-liquidity-metrics.test.ts) 在 #03 API → 指标边界运行，保留原快照、缓存、过滤和所有只读限制。复用 #02 已核验结论，无新增官方事实缺口或重复研究。

- `bestBidApr/bestAskApr/midApr/spreadApr` 使用聚合盘口 APR fraction；另提供 `spreadPp/spreadAprBp`，标记 `bookTickSize=0.0001` 与 `aprConvention=aggregated-fraction`。Spread 用两侧聚合索引差计算，避免误用现货相对价差；负/零 APR 和零 mid 有效。交叉盘口保留带符号负值及 `CROSSED_BOOK`，异常证据标 partial。
- bids/asks 各自输出 `levelCount/farthestApr/visibleDepth`。只对有效返回档 `sizeRaw` 作 BigInt 求和，复用 18-decimal 格式化，输出精确十进制字符串；数量声明为 `returned-levels` 可见范围，不输出全书总量、保证成交数量或跨 market 合计。
- `windows` 固定 10/25/50 APR bp，记录 fraction 宽度、包含端点的 from/to APR。bids 为 `[bestBid-w,bestBid]`，asks 为 `[bestAsk,bestAsk+w]`；以整数聚合索引比较端点。无舍弃/契约违约且返回尾部已严格越过窗口时，覆盖为 `bounded-aggregation-window`；达到 cap 且尾部仍在窗口（包括端点）时为 `lower-bound`/partial；不足 50 档但尾部未越过也保持 coverage-unknown。无效/重复/客户端截断不能提升为 complete。
- 深度同时提供 `yu/collateralNotional/usdNotional`。身份可验证时，1 YU 对应 1 抵押资产单位名义敞口；保留官方 symbol，明确 `NOMINAL_EXPOSURE_NOT_CASH_OR_MARGIN`，不按 ERC20 decimals/期限/APR 再次缩放。collateral 缺失/不匹配保留原生 YU，换算 UNKNOWN。#03 assets 的价格更新时间未公开，因此 USD 始终 UNKNOWN，标记 `PRICE_SOURCE_TIME_UNKNOWN`，不采用 USDT=1 或 underlying 价格替代。Volume 与单边 OI 原样保留，不从深度生成。
- 完整有效空侧可见深度为字符串 `0`；缺侧、ia/sz 错配或全部舍弃的侧深度为 null/UNKNOWN。没有 best 时，best/mid/Spread 与相对 best 的窗口均 UNKNOWN。派生 measurement 保存输入来源、独立时钟、完整性和失败原因；不把计算时刻冒充采集或源时间，stale/UNKNOWN 不被提升为当前完整证据。
- TDD：先确认 API 缺少 metrics 失败，再实现 APR/可见深度；先确认窗口字段缺失失败，再实现窗口。12 项新测试覆盖方向/排序、fraction/pp/bp、BigInt 精度、负/零、端点、空/单边/交叉、cap 与客户端违约、无效/重复、单位/价格时间、来源及 stale 传播；含 #03/client/opportunities/pair 的定向回归 156 项通过。
- 验证：`yarn verify` 通过（根 108 文件、2584 通过/8 跳过；web 99 文件、1451 通过；两端 typecheck），`yarn --cwd web build` 通过，差异格式与文档链接检查通过。完整验证在允许安装脚本测试子进程的环境运行；现有 React/MSW 日志及 bundle 大小提示未使检查失败。
- code-review 以 `59472ef` 为基点，规范轴 0 项、规格轴 0 项。仅 #04 resolved；未实现 #05 UI/真实浏览器验收、任何账户展期或执行逻辑，父票 01 未关闭。
