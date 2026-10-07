# 原子展期风险监控工作地图

Updated: 2026-10-07 Asia/Taipei

[规格](spec.md) · [01 父级验收清单](issues/01-atomic-rollover-risk.md)

先交付第一阶段市场流动性指标，再推进第二阶段账户原子展期风险。01 为父级追踪，不认领为单次实现。子票的 ready-for-agent 表示范围明确；Blocked by 依赖仍须 resolved 后才允许认领。实现前写入 claimed，完成时追加 Answer/证据并记 resolved；拆票时没有实现或验收完成；后续结果逐票追加到结论记录。

| 票 | 阶段 | 交付 | Blocked by | 进度 |
| --- | --- | --- | --- | --- |
| 02 | 一 | [Boros market 流动性数据源与单位核验](issues/02-boros-liquidity-sources.md) | — | resolved |
| 03 | 一 | [Boros market 流动性快照只读获取](issues/03-boros-liquidity-snapshot.md) | 02 | resolved |
| 04 | 一 | [Boros Spread 与双边订单簿深度计算](issues/04-boros-liquidity-metrics.md) | 03 | unclaimed / open |
| 05 | 一 | [Boros market 流动性指标展示与第一阶段验收](issues/05-boros-liquidity-view.md) | 04 | unclaimed / open |
| 06 | 二 | [原子展期计划身份、候选市场与四腿权限](issues/06-atomic-rollover-plan-permissions.md) | 05 | unclaimed / open |
| 07 | 二 | [四腿有效深度、执行 APR 与价格边界](issues/07-atomic-rollover-effective-depth.md) | 06 | unclaimed / open |
| 08 | 二 | [完整展期模拟、批次保证金与执行准备证据](issues/08-atomic-rollover-batch-readiness.md) | 07 | unclaimed / open |
| 09 | 二 | [Risk 状态、新鲜度、经济性与到期语义整合](issues/09-atomic-rollover-risk-integration.md) | 08 | unclaimed / open |
| 10 | 二 | [原子展期 Risk 页面与全范围验收](issues/10-atomic-rollover-view-acceptance.md) | 09 | unclaimed / open |

## 验收范围映射

以 01 原始 Acceptance Criteria 顺序编号（1–17）追踪，不删除原始条件。

| 原条件 | 负责子票 |
| --- | --- |
| 1 计划身份、2 全量/残余、3 权限 | 06 |
| 4 四腿深度、5 滑点/协议边界 | 07 |
| 6 完整模拟、7 平旧后开新保证金、8 盘口与模拟数量、9 执行准备 | 08（盘口部分 07） |
| 10 来源/新鲜度、11 状态分离、12 到期/PAUSED、13 切换与结算、15 指标语义一致 | 09 |
| 14 只读、16 离线/浏览器、17 范围控制 | 所有子票分别遵守；10 最终核验 |
| 新增市场流动性字段、单位与第一阶段浏览器验收 | 02–05 |

## 阶段关口

- 第一阶段：02–05 全部 resolved，有来源契约、只读快照、指标计算、页面与浏览器证据。缺失数据明确 UNKNOWN，不要求原子展期就绪。
- 第二阶段：06–10 全部 resolved，10 逐项核对 01 原始条件和 spec 测试，才关闭父票。

## 结论记录

2026-10-07：完成工作拆分；02 是首个无依赖开放票。官网截图为字段/布局参考，不代表当前市场证据。

2026-10-07：#02 resolved，交付 [消费契约](research/02-liquidity-contract.md) 与 [官方证据](research/02-official-sources.md)。rolling 24h volume、单边 OI、YU 单位、book best-50/AMM scope 已核验；官网 OI 算法、统计独立时间和覆盖限制保持 UNKNOWN。#03 的依赖 02 已满足，可以认领；#03–10 未实现，01 未关闭。

2026-10-07 #02 验证与审查：根 typecheck、Boros client 定向 43 项、完整 yarn verify（根 106 文件/2554 通过/8 跳过；web 99 文件/1451 通过及两端 typecheck）、web 生产构建、14 份文档本地链接与格式检查全部通过。首次沙箱内安装脚本测试因 spawnSync bash EPERM 失败；允许子进程的环境重跑完整 verify 后通过。测试仍有 React/MSW 日志，构建有包体积提示，均未使检查失败。code-review 标准轴 0 项、规格轴 0 项；未新增生产逻辑，因此不添加镜像式测试或应用 TDD。研究只用了公开 GET，未进行交易或账户查询。本次提交含此前拆票框架，保证文档引用可随提交检出；其余票未实现。

2026-10-07：[#03](issues/03-boros-liquidity-snapshot.md) resolved。交付 `GET /api/boros/liquidity`：固定公开 UI whitelist/live scope、分页覆盖、逐字段/逐侧来源与独立时钟、native rolling 24h YU/单边 OI、精确 18-decimal book raw 与 best-50 限制、UNKNOWN/partial/stale/失败证据。复用公开 client seam 与原 TTL/429 冷却，缓存按部署/chain/market/query scope 隔离，无账户或交易调用、无后台采样。18 项新 API 用例、144 项定向回归、完整 verify（根 2572 通过/8 跳过、web 1451 通过及两端 typecheck）、web build 与格式检查通过；规范建议整理后复审 0 项，规格轴 0 项。未提前实现 #04–05；#04 依赖已满足，仍未认领，第一阶段/父票尚未完成。
