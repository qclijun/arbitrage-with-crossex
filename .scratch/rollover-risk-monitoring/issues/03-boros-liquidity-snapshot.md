# 03: Boros market 流动性快照只读获取

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第一阶段：市场流动性
Progress: resolved
Blocked by: 02

## Problem

按 02 核验后的契约接入逐 market 的公开统计与双边订单簿快照，为指标计算提供可追溯输入。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [x] 复用已有 market 列表、统计、orderbook 适配器和缓存，返回 market 身份、24h Volume、Notional OI、双边档位及原始单位；首期范围为当前终端 market 列表可覆盖的 Boros markets，显式报告过滤条件与覆盖范围。
- [x] 每个来源携带 source、sourceObservedAt（未知可空）、collectedAt、freshness、completeness、reason；统计与盘口各自计时，不伪装成同一时刻。源时间未知不能用接收时间冒充。
- [x] 分页未完成、截断、单边失败、缺少字段、过期和请求失败逐字段保留 UNKNOWN 或部分覆盖；完整空盘口与数据不可用区分。保留旧快照时标明过期与失败。
- [x] 缓存按 market 身份和查询范围隔离，复用当前刷新策略与限流；只读查询不触发模拟、签名、交易、授权、Gas 补充、后台监控或通知状态变化。
- [x] 离线 API 验收涵盖多到期/多 venue、分页与部分失败、源时间缺失、过期和完整空盘口；证明 market 统计来源为市场全量而非账户 fills。

## Out of Scope

账户展期计划、四腿就绪/保证金结论、历史成交量与订单簿持久采集、自动展期及交易操作。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。

## Answer

2026-10-07：resolved。新增 `GET /api/boros/liquidity`，实现 [公开快照契约](../../../src/core/boros/liquidity.ts)、[只读路由](../../../src/server/routes/borosLiquidity.ts) 与 [离线 API 验收](../../../tests/server/boros-liquidity.test.ts)。复用 client 的公开请求、markets 分页与 book 原始读取 seam，旧策略适配器仍使用原来的查询/归一化语义；不需要重新核验 #02 已证实的官方字段。

- 范围固定为当前部署/chain 的 `isMatured=false,isUiWhitelisted=true,limit=200`，上游 whitelist 限制独立披露，不按账户持仓/组合或可对冲 venue 二次筛选；pure book 为 `tickSize=0.0001,includeAmm=false`。列表报告页数、返回数量、未完成 cursor；缺失 cursor、重复/乱序 ID、游标循环、不前进、后续页失败与 20 页保护上限都保留 partial/UNKNOWN。
- 身份保留 platform、完整 symbol、underlying/funding symbol、tokenId、到期、market address 和返回的过滤字段；collateral 来自公开 assets 的 tokenId 严格对照。缺失/重复资产、未知地址不能通过资产 id 或另一 market 推测。
- `volume24hYu` 为市场全量 rolling 24h 原生 YU，`notionalOiOneSidedYu` 明确单边口径；不除 1e18/2，也不以账户 fills 生成统计。统计 `sourceObservedAt=null`、`freshness=unknown`（接收后过期为 stale），保留统计更新时间与 trade-route 覆盖 UNKNOWN；market syncStatus 仅保留，不充当统计时间。
- book 的 long→bids/short→asks 各自保留 raw 数组、精确 `sizeRaw`/`sizeYu` 字符串、聚合索引与 APR；负/零 APR 有效。同步秒时间经量级/未来值校验后才转毫秒。每侧披露有效/舍弃/返回档数、best-50 cap、可能截断与 `returned-levels` 范围；完整空数组为完整空响应，缺侧/错配为 UNKNOWN，无效档不能伪装成完整空书。未计算 Spread 或累计/窗口深度。
- 复用 `TtlCache`，统计/资产 30 秒、book 90 秒，独立采集时间；缓存键包含部署、chain、market 与过滤/盘口查询范围，与旧 normalized/quote/trade keys 隔离。请求失败可保留旧值并标 stale/failure，429 复用原 per-key 2 秒冷却；按需串行取 book，无后台轮询或强制刷新。
- TDD API seam：先证实新路由 404，再实现；分页乱序用例先失败后修正。18 项新 API 测试覆盖上述边界，并以公开 GET allowlist、账户/写入口拒绝 stub 和旧缓存哨兵验证只读及隔离；定向 client/opportunities/pair 回归共 144 项通过。
- 验证：最终 `yarn verify`（根 107 文件、2572 通过/8 跳过；web 99 文件、1451 通过；两端 typecheck）、`yarn --cwd web build` 和差异格式检查通过。完整验证在允许安装脚本测试子进程的环境运行；现有 React/MSW 日志及 bundle 大小提示未使验证失败。
- 审查基点 `576af46`：code-review 规范轴无硬性违规；证据构造长参数建议已改为 typed options，复审 0 项。规格轴及跟进复审 0 项。仅 #03 resolved；#04–05 的指标与 UI、真实浏览器验收没有提前实现，父票 01 未关闭。
