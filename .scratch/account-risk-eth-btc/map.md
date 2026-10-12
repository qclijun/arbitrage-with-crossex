# ETH/BTC 账户级风险报告工作地图

Label: wayfinder:map
Status: resolved
Updated: 2026-10-13 Asia/Taipei

## Destination

按 [实施规格](spec.md)交付 Gate CrossEx 与 Boros 的 ETH/BTC 账户级只读风险报告，统一风险页、监控和只读报告的指标、证据状态与判定。

## Decisions

- [01 — ETH/BTC 账户级风险报告](issues/01-account-risk-eth-btc.md)：resolved。完成多来源永续数量和敞口、Gate/Boros 当前盈亏、独立抵押池健康与结算续航、真实 UNKNOWN 保留、跨消费者同步及兼容性。

## Verification

- `yarn verify`、Risk Monitor Python 单测、生产 Web build 和最后精度修复的定向 Web 测试通过。
- Chrome 合成数据视觉验收通过；运行时只读验收已完成，实际账户状态和持仓不纳入公开记录。非零 BTC 情形由离线合成夹具验证。
- 运行时：只读验收记录保存在本地私有资料中；未执行测试通知、下单或资金操作。
