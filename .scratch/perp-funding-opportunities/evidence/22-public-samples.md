# 22 公开只读样本与预算校准记录

采样完成：2026-10-29T16:35:37.762Z（UTC），2026-10-30 Asia/Taipei。独立于默认 verify；无账户查询、无交易、无配置更改。共 19 次场所公开 HTTP 请求，另 1 次 unsigned CrossEx rules 请求。

## 样本结果

| 场所 | 返回 | 产品/历史样本 | 时延 ms（min–max） |
|---|---|---|---|
| BINANCE | 451 | 产品与历史均访问受限；能力 UNKNOWN | 184–2169 |
| ASTER | 200 | 原生产品 606；BTCUSDT p1=1000; BTCUSDT p2=97; HYPEUSDT p1=43; XTENUSDT p1=57 | 297–3197 |
| OKX | 200 | 原生产品 511；BTC-USDT-SWAP p1=270; HYPE-USDT-SWAP p1=21; MPWR-USDT-SWAP p1=7 | 338–2613 |
| BYBIT | 403 | 产品与历史均访问受限；能力 UNKNOWN | 198–1456 |
| HYPERLIQUID | 200 | 原生产品 235；BTC p1=500; BTC p2=500; HYPE p1=168 | 314–3855 |

CrossEx 返回 12652 条全业务规则，响应哈希 `54b7170630ac64c904df88ccfb8ffd4b90a6ae41b13e746255cf9005a9c650ff`。当次解析得到 1258 个原生映射；独立经济证明只命中 OKX BTC/ETH，因此当前出口下没有跨场所可比较候选。拒绝项按场所：`{'GATE': 1064, 'BINANCE': 791, 'BYBIT': 876, 'OKX': 254, 'DERIBIT': 142, 'KRAKEN': 207, 'LIGHTER': 191, 'HYPERLIQUID': 140}`。不能把当前 0 候选解释为市场无机会。

## 分页、周期、上市与 HL

Aster BTC 365 天首 1000、重叠末时间后次页 97；HL BTC 首/次页均 500，游标持续推进，本探针按两页上限停止，未证明全年完整。OKX BTC 90 天 270 条，180/365 天由该端点 unsupported。

Aster 样本 BTC 约 8h、HYPE 约 4h、新品 XTEN 约 1h；OKX 本次 BTC/HYPE/新品 MPWR 均观察到约 8h，未覆盖第二种周期。观察间距不是历史规则生效证明。Aster 与 HL 均存在毫秒偏移，不得由此推导已证明的 UTC 结算整点映射。上市仅以官方 onboardDate/listTime/launchTime 字段为依据；缺失不猜测。

> 2026-10-31修订：历史周期改按“双重证明”（规则结算记录 + 当前官方周期）判定，见[历史证据与资格契约](../history-and-eligibility.md)末节“修订 2026-10-31：周期双重证明”；同节记录Binance不足1秒的fundingTime抖动映射，Aster仍不映射。

新增官方证据：[HL info endpoint Pagination](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)明确时间范围最多返回 500 elements 或 distinct blocks，并以最后时间作为下一 startTime。本次连续满页及短页与其一致，修正07“未见条数上限”的旧结论。它只支持分页，不证明历史周期、上市或 rawTime 的整点经济语义。实际完整性仍由逐期检查独立决定。

## 响应头和预算

Aster exchangeInfo 实测 `x-mbx-used-weight-1m=1`，正文 REQUEST_WEIGHT/MINUTE/1 的 limit=2400；历史响应缺少该头时 minuteUsed=UNKNOWN，不能按 0 处理。实现将数值分钟权重与同周期声明上限匹配，在 80% 阈值后冷却一分钟；绝不拿分钟权重当 Binance fundingRate/fundingInfo 的 500/5min 计数器。

本机分钟保护预算：Binance 400 次/5min（共享资金费配额留余量），Aster 30 次/min，OKX 8 次/2s，Bybit 100 次/5s；HL 900 保守权重/min，请求前预留45（20基础+500条响应增权上界），不向并发借无限额度。仍受09每轮240总请求/40每场所、2并发、5s超时等更低限制。它们是内部保护，不是实测容量承诺；其他进程/IP共享负载无法由本样本排除。

**公开校准限制：** 本次未返回 Retry-After、Bybit remaining/reset 或真实429/418；不故意耗尽共享IP额度。秒数/HTTP-date Retry-After、Bybit业务限流/剩余额度、MBX高权重及HL并发预算仅由离线fixture验证。Binance451/Bybit403使其生产容量、头和分页行为在此出口仍 UNKNOWN；五源完整限流实测尚未证明。没有更换出口或把访问失败解释为不存在历史。

## 重跑与证据

手工执行（不在 verify 内）：

```sh
yarn tsx .scratch/perp-funding-opportunities/evidence/22-public-probe.ts /tmp/issue22-public-probe.json
```

本次完整只读摘要位于 `/tmp/issue22-public-probe-final.json`；不保存凭据或账户fixture。下列每页哈希绑定实际公开响应，完整原始响应未归档：

| 场所/合约/页 | 首末 rawTime | next cursor | SHA256 |
|---|---|---|---|
| ASTER/BTCUSDT/1 | 1761753600001–1790524800000 | 1790524800000 | `3fba56d291a30a8eb7c26b949980f223ffb72e0ca38d3f0a566c9b04f34e7ce6` |
| ASTER/BTCUSDT/2 | 1790524800000–1793289600000 | None | `5fc425df46e771f3d6d56c3d5cbd7e95b4d4723066db323cb31fab787aefa95f` |
| ASTER/HYPEUSDT/1 | 1792684800002–1793289600000 | None | `dffd884d9b958beb34e7010774a3599864d0f28b3b5efa334ec25344d961d208` |
| ASTER/XTENUSDT/1 | 1793088000001–1793289600000 | None | `b79060542625355c5a0db02efc67d173c75f3e5ad44917c5205b68af564c885b` |
| OKX/BTC-USDT-SWAP/1 | 1785542400000–1793289600000 | None | `2de04e5870f35fe3ba4b0985881f2ac6afe55fdc8bdf1998791448e49fe4a2ad` |
| OKX/HYPE-USDT-SWAP/1 | 1792713600000–1793289600000 | None | `5d3790e0bcd0e410ef476539d07660ab4c521bfe24694280431beb137cebfd1c` |
| OKX/MPWR-USDT-SWAP/1 | 1793116800000–1793289600000 | None | `b20de429600bbc198cb10fef81f1507e75c5a682f3b14272f33d3b9e9c1fbc23` |
| HYPERLIQUID/BTC/1 | 1761757200196–1763553600026 | 1763553600026 | `4f0538a38a5f9ce855b0b705945f0049607781d78e36dd4e6d14f755f096e6c0` |
| HYPERLIQUID/BTC/2 | 1763553600026–1765350000025 | 1765350000025 | `2a0def146661b858a64a50f7fcbfb065685d0757ba10ba17b2584b4a0ff3e94d` |
| HYPERLIQUID/HYPE/1 | 1792688400041–1793289600013 | None | `a4b6214a86bf48767aa1f517392eec7cb19ca2ba272e8ebcbdef6ec952196ad9` |
