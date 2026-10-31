# ETH 空HL、多OKX比较交接

2026-10-31：用户询问Directed pair rankings为何没有ETH空Hyperliquid、多OKX，以及与当前六个方向的比较。只读核对正式接口和当前配对代码：HL ETH被标为underlying-unverified，经济身份白名单仅有三家CEX的BTC/ETH；同时HL oracle-notional与CEX mark-notional被分组隔离。当前每币六方向来自三家CEX的有向排列。生产HL ETH旧缓存还因预算耗尽落后一个截止小时，故未直接混合旧HL和新CEX计算。

重新公开读取并补齐超时旧区间后，统一截止为台北时间2026-10-31 22:00。HL空减OKX多的7/30/90/180/365天费用前年化费率差为0.8055%/2.9095%/3.6677%/3.9122%/3.9869%。若作为费率筛选估算纳入ETH现有六方向，7天第3，其他窗口第1。中长窗口也高于此前BTC六方向最高值。计算基于同名义金额的费率差，实际等ETH数量的现金流须乘各期价格，并处理USDC/USDT和费用差异。

本次比较未改生产代码、配对准入或账户状态，未发送交易请求；分析摘要随 Funding 修复提交。只读分析已完成，若后续纳入HL候选，需要独立处理身份映射与跨计价基准的展示/执行语义。

## 数据与复核

仓库保留计算摘要；原始抓取、临时脚本和缓存由 `.gitignore` 过滤，留在本机。

- [计算摘要](2026-10-31-eth-hl-okx-comparison.json)：精确十进制计算、ETH六个方向原值、BTC各窗口最优对照。
- 本机原始记录 `2026-10-31-eth-hl-okx-public.json`：HL五窗口168/720/2160/4320/8760期，OKX为21/90/270/540/1095期，全部通过覆盖检查。初轮HL全年超时；补读185天4440期，9次请求，并与新鲜180天数据无重叠拼接。保留首次失败报告和恢复信息。
- 本机临时脚本 `2026-10-31-eth-hl-okx-public.ts`、`2026-10-31-eth-hl-okx-tail.ts`；日志`/tmp/funding-eth-hl-okx-public.log`、`/tmp/funding-eth-hl-okx-tail.log`。
- 正式只读缓存：`/tmp/funding-hl-okx-ETH-pairs.json`、`/tmp/funding-hl-okx-BTC-pairs.json`、`/tmp/funding-hl-okx-ETH-settlements.json`；均保留为0600文件，不含凭据。
- 代码：`contract-evidence.ts`的ECONOMIC_PROOFS及rateBasis、`ranking.ts`的enumerateFundingCandidates。
- [HL官方资金费说明](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)：结算金额为position_size × oracle_price × funding_rate。
- [OKX官方资金费说明](https://www.okx.com/en-us/help/perps-funding-fee-mechanism)：USDT/USDC线性合约头寸价值按mark price计算。
