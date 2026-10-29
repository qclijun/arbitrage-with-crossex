# 官方历史适配器与合约身份证明映射

Type: task
Status: open
Assignee: none
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
