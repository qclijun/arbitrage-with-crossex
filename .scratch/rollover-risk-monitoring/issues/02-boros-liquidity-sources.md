# 02: Boros market 流动性数据源与单位核验

Status: ready-for-agent
Type: research
Created: 2026-10-07 Asia/Taipei
Parent: [01](01-atomic-rollover-risk.md)
Phase: 第一阶段：市场流动性
Progress: resolved

## Problem

核验公开 market 列表、24h 市场成交量、Notional OI 与双边订单簿的官方来源，先固定可实现的数据契约。截图仅是官网展示参考，不是实时数据或 API 字段证明。

## Specification

遵循 [分阶段完整规格](../spec.md) 与 [工作地图](../map.md)。只实施本票范围；依赖交付的数据契约如存在缺口，记录原因，不以猜测补值。

## Acceptance Criteria

- [x] 记录可复现的官方文档/只读请求、响应字段、分页、覆盖范围、源时间、频率限制与项目现有适配器；优先复用当前市场数据和缓存，不新建采集系统。
- [x] 区分 venue、交易对/标的、market ID、抵押资产、到期日；同一标的不同 venue/到期 market 必须独立。核验展示单位与原始 YU、sizeToken、抵押资产数量的换算依据。
- [x] 核验 24h Volume 是否滚动 24 小时、是否市场全量、统计更新时间；区分成交名义量、抵押量与 USD 值。Notional OI 是未平仓量，不能当成交量或盘口深度。
- [x] 核验订单簿 bid/ask 与 APR 的方向、排序、档位数量单位、分页/截断标志及 AMM 是否独立；不能套用未经验证的现货价格方向。
- [x] 把官网截图 ETHUSDC 的 24h Volume、Notional OI、到期日、抵押资产及 venue 分组作为人工对照项；保留截图来源日期未知、非实时、显示值已舍入的限制。截图未展示 Spread 或深度，不能据此补造数值。
- [x] 形成后续票使用的数据字段/单位/方向/缺失状态契约和来源证据；不可用字段明确 UNKNOWN 与原因，不以账户成交记录替代市场量。

## Out of Scope

账户展期计划、四腿就绪/保证金结论、历史成交量与订单簿持久采集、自动展期及交易操作。

## Comments

2026-10-07：由 01 拆出；第一阶段优先市场流动性指标，依赖未 resolved 前不认领实现。

2026-10-07：认领 #02，执行官方只读来源核验及既有适配器审计；交付研究契约，不推进 #03–05。

## Answer

2026-10-07：resolved。交付 [字段/单位/方向/缺失状态契约](../research/02-liquidity-contract.md) 与 [官方来源及只读请求证据](../research/02-official-sources.md)。本票为 research，未修改生产代码；#03 才接入快照获取。

- AC1：公开 GET、分页/过滤/CU 限额/同步时间及现有适配器/缓存均已核验；官方 schema 与旧文档的路径、ia 描述和预算差异显式记录。
- AC2：固定 deployment/marketId 及 venue、完整交易对、collateral、到期身份；说明 YU raw/1e18、已缩放统计、sizeToken 的名义规模与现金抵押/保证金不同。
- AC3：volume24h 为官方定义 rolling 24h 的 sum(abs(trade.size))，notionalOI 为单边 getOI()/2；统计独立更新时间和所有 trade 路由覆盖未文档化，保持 UNKNOWN。
- AC4：核验 long bids / short asks、ia*tickSize、排序、固定 18-dec YU、服务 best-50 硬限制与 includeAmm=false；无法证实全书深度，明确 returned-levels 覆盖。
- AC5：截图五行按 ETHUSDC/venue/到期/collateral 对照官方 market；四行显示 OI 约为 API 单边值两倍，12 月行已有变动，官网 OI 公式仍 UNKNOWN。未从截图捏造 Spread/深度。
- AC6：交接契约列明逐字段 provenance、sourceSync 与 sourceObservedAt 区别、完整空书/未知侧、桶化 Spread、深度窗口边界与 USD 缺价/缺时间规则；缺失值不补零。

验证：根 typecheck 与 Boros client 定向测试（43 项）通过；完整离线验证及双轴审查结果见工作地图最终记录。只读访问官方公共数据，不运行真实下单测试。
