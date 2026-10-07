# 05: Boros market 流动性指标展示与第一阶段验收

Status: ready-for-agent
Type: task
Progress: resolved
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第一阶段：市场流动性
Blocked by: 04

## Problem

在现有终端市场/风险页面的合适入口展示逐 market 的流动性快照，完成第一阶段闭环。复用现有页面与查询，不建设新的监控系统。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [x] 逐 market 展示 venue、交易对、market ID、抵押资产、到期日、24h Volume、Notional OI、best bid/ask APR、Spread 与双边深度窗口；便于比较同标的不同到期市场，不合并其数据。
- [x] 显示单位、窗口口径、源时间/采集时间、过期/不完整/UNKNOWN 原因；成交量/OI 与盘口可不同步。展示市场模式时只作元信息，未经后续权限核验不推断交易可用性。
- [x] 使用截图的 venue 分组、Collateral/Maturity/24h Volume/Notional OI 作为信息组织参考；不要求像素复刻官网，不把截图数值当生产数据。
- [x] 页面明确为市场流动性诊断，不输出原子展期 ready、保证可成交量或保证金结论；不新增流动性阈值告警、不更改通知/去抖。
- [x] 完成离线 API → 指标 → 页面验收，涵盖正常/部分失败/空盘口/过期状态与 market 切换；完成真实浏览器宽屏及 375px 验收，确认无横向溢出并留存截图。只读官网/生产数据对照记录采集时刻与舍入差异，禁止真实下单测试。
- [x] 验收 02–05 交付证据与第一阶段字段完整性；不可支持字段显式列出限制，不能用伪造值通过。第一阶段完成即停，后续按 06–10 单独推进。

## Out of Scope

账户展期计划、四腿就绪/保证金结论、历史成交量与订单簿持久采集、自动展期及交易操作。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。

## Answer

2026-10-07：resolved。新增现有终端的 Liquidity 标签与逐 venue / market 比较列表，选择市场显示统计、聚合 best bid/ask/Mid/Spread、逐侧可见深度及含端点的 10/25/50 APR bp 窗口。复用 `GET /api/boros/liquidity` 与现有查询/缓存；30 秒仅在可见页刷新，不强制绕过缓存、不新增后台采样。

- 逐字段来源/源时间/采集时间/新鲜度/完整性与原因可展开；统计与两侧盘口独立，过期与请求失败保留值显式 STALE，完整空侧为 0、未知侧不补零。YU/抵押资产名义敞口与现金/保证金区分，USD 时间不可验证保持 UNKNOWN。聚合桶 1 APR bp / 0.01 pp 与两位 APR 舍入显式说明；模式只为元信息，不推断权限或原子展期就绪。
- [第一阶段验收与限制](../evidence/05/acceptance.md) 核对 02–05 证据；[宽屏](../evidence/05/wide-diagnostics.jpg)、[375px](../evidence/05/mobile-diagnostics.jpg) 及分组/来源展开截图证明真实页面无横向溢出，market 197→198 切换正确。截图仅为公开市场区域，不保存账户数据。
- 官方 API market 197 只读对照保存实际采集时间、独立盘口时钟及桶化/舍入差异。官网 UI 返回 HTTP 451 地区限制，实时 UI 数值对照 UNKNOWN；未绕过，保留 #02 旧截图未知日期及 OI 口径限制。统计源时间、trade 覆盖、USD 价时间、全书深度等不可验证字段明确列出，不伪造补值。
- 验证：根 typecheck、108 文件完整离线测试（2584 通过 / 8 跳过）、web typecheck、100 文件完整 web 测试（1456 通过）、web 生产构建与格式/链接检查通过。默认高并发 web suite 的既有 App.setupOnce 初始化等待两次超时；该文件单独 2 项通过，降低到 2 workers 后整套通过。新页面 4 项测试、API/指标 30 项、隐藏页定向回归通过；未启用 live 交易测试。
- code-review 基点 `9b5767817aef9d8c9228fa5debda8091ffcaf753`：Standards 硬性违规 0，TTL 命名建议已修；Spec 聚合桶精度说明缺口已修，复审 0。现有运行后端未重启；浏览器通过临时仅公开 GET 的 route 服务验收，临时服务/文件已清理。部署后须由正常更新流程加载新页面及路由。

02–05 已 resolved，第一阶段完成即停；06–10 未实现，父票 01 保持开放。
