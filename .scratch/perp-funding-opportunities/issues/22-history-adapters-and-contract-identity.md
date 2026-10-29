# 官方历史适配器与合约身份证明映射

Type: task
Status: claimed
Assignee: Codex
Blocked by: 07, 08, 09, 18

## Goal

为09刷新器和18/12端口提供生产数据：按[07来源研究](../evidence/history-source-research.md)实现各场所官方结算历史`FundingHistorySource`，并提供CrossEx合约到场所原生contractId及已证经济标的/费率口径的映射（`FundingContractListing`）。

## Scope

- Binance/Aster/OKX/Bybit/Hyperliquid官方历史接口的分页、上市时间、历史周期与HL毫秒→结算整点映射证据；不能证明的场所保持`unknown`/`unsupported`，不以当前bulk feed代替历史。Retry-After/权重头解析及预算在公开样本上实测校准。
- CrossEx规则符号→(venue, 原生contractId)、经济标的及费率口径证据；别名归一化、ticker相同不算证明。映射同时供12的`legOf`与18的候选枚举，单一来源。
- 在`src/server/index.ts`把映射接入18的`createFundingMarket({ contracts })`与刷新器`sources`；接线后18页面才有真实候选，此前如实显示未接线/冷启动。

## Acceptance

离线fixture覆盖分页/上市/周期/HL映射/限流与映射拒绝路径，fixture不证明生产完整；公开样本实测记录单列且不进默认verify。不运行live交易、不启用开仓。

## Comments

- 2026-10-29：自18拆出（用户选择另开新票）；18交付的端口与只读页在本票接线前显示`contracts: unwired`。

- 2026-10-30：Codex 按用户请求认领；07/08/09/18 均已 resolved。用户确认以历史来源、合约映射公开接口和只读 API 为测试边界。

## Answer

2026-10-30：实现、生产只读接线及双轴代码审查已交付；**保留 claimed，未宣称五源公开校准全部验收**。

- 官方五源分页、原生产品/上市信息、独立经济身份及费率口径、响应头/预算冷却均已实现。候选与12 `legOf` 共用市场目录；unsigned CrossEx 规则不依赖账户凭据。未证历史周期、HL上市/整点映射以及未收录的经济身份继续 UNKNOWN，人工开仓保持关闭。
- [逐产品证据](../evidence/22-contract-identity-evidence.md)、[公开样本及校准限制](../evidence/22-public-samples.md)、[双轴审查](../evidence/22-review.md)。公开样本取得12652条规则、1258个原生映射；当前出口仅OKX BTC/ETH独立经济证明命中，无跨场所可比较候选，不等于全市场无机会。
- 离线fixture与只读API覆盖分页/上市/生效周期/HL独立映射/限流/映射拒绝；公开探针手工运行，默认verify不访问场所。首次完整门禁另暴露既有提示框竞态，已先红后绿修复并双轴复审，见[门禁修复](../evidence/22-full-gate-repair.md)。最终默认完整`yarn verify`退出0（后端3614通过/8跳过、前端1788通过），production UI build通过；最终验证及本地提交见[实施交接](../evidence/22-implementation-handoff.md)。
- 待办：工单Scope要求“Retry-After/权重头解析及预算在公开样本上实测校准”；Binance451、Bybit403，以及未观察Retry-After/真实429等，使五源完整公开校准仍 PARTIAL/UNKNOWN。取得可用且获授权的公开证据后补验；不换出口、不主动耗尽共享IP额度、不用fixture冒充公开证据。此前不把本票改为resolved，也不解除21的22依赖。
