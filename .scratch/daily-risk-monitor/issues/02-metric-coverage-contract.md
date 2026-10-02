# 八类风险的指标覆盖边界与未知状态如何定义

Parent: ../map.md
Label: wayfinder:grilling
Type: grilling
Status: resolved
Assignee: Codex
Blocked by: none

## Question

核定 checklist 每个检查项的数据源、单位、阈值和有效期。无法自动核实的托管、合约及预言机事件，是否以人工确认有效期及官方公告核查记录覆盖？如何区分 UNKNOWN 与 WARNING/CRITICAL，避免人工确认被误读为“没有风险”？

## Comments

- 用户已同意其余方案；基本覆盖契约已获授权并用于32项脚本实现。该议题保留给外部证据覆盖的后续深化，不阻止现有检查输出UNKNOWN。
- 已进一步实测官方原始market-acc-infos-by-root，按root/accountId/tokenId/cross组取netBalance、initialMargin及availableMaintMargin；清算健康度由官方字段派生。gas-balance读取balanceInUSD。无需再以Gate挂单推测Boros组余额。

- 指标草案：[日常风险检查指标草案](../checklist-draft.md)。
- 本地实测：账户、持仓、成交、费率、asset-view、Boros pair context 可用于多数数值指标。
- Boros pair context 会筛掉部分暂停/到期市场，不能拿其返回列表作为“市场不存在/无风险”的证据。
- asset-view 提供初始保证金，不能据此伪造官方维持保证金 Health Ratio；需进一步核对原始 Boros 账户数据。
- 公告正常和人工确认有效只代表证据新鲜，不代表托管或协议安全得到保证。
- 源码探索结果：gas可通过只读simulate取得；books仅顶部报价；meta.ts只是响应时间；本地稳定币USD价格恒设1；ADL原因缺乏可靠标签。已将这些限制补入清单。
- 现有数据不能完成所有指标的自动实测，需在本议题明确独立数据源和人工证据策略，然后才可称完成覆盖。

## Answer

2026-10-02：交付70个指标的机器可读契约与来源、单位、类型、枚举和外部证据最长有效期。拒绝无效类型、非有限数值、单位错误、未来/过期证据；UNKNOWN独立于数值风险，已测CRITICAL不能被缺失证据清除。实时测量优先；运行状态不能人工伪造。托管/协议clear只表示本次核查证据新鲜，不保证安全。ETH总暴露需覆盖其他资产及对冲，单个Boros组不能替代。全部32项有独立合成风险场景，边界及迟滞已离线验证。

详见 [指标契约](../../../docs/RISK-MONITOR-CONTRACTS.md)。未接入的外部源继续UNKNOWN；本议题完成指标契约，不宣称所有外部数据已上线。
