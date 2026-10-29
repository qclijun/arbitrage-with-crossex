# 22 合约身份取证与证明边界

日期：2026-10-30 Asia/Taipei。以下是逐产品人工核对的证明表，不是 ticker 别名表。

## 原生合约映射

[CrossEx 官方规则](https://www.gate.com/docs/developers/apiv4/en/crossex/)定义 exchange/business/base/quote 编码，并示例 `BINANCE_FUTURE_ADA_USDT,OKX_FUTURE_ADA_USDT`。生产必须同时读取当次 live FUTURE 规则及场所官方产品记录，核对 venue、原生 ID、base、quote、永续/linear、live 状态；任何一项不符、重复或源失败均拒绝。绝不做 XBT→BTC、kPEPE→PEPE、大小写或千倍合约归一化。

原生格式只在官方产品记录精确命中时成立：Binance/Aster/Bybit `BASEUSDT`；OKX `BASE-USDT-SWAP`；HL 原生 `coin`（仅第一 perp dex，无 HIP-3 冒号 ID）。CrossEx 的 USDC twins、币本位或尚无官方来源的其他场所明确留在 rejected 中。`mappingEvidence` 保存规则约定与原生响应哈希，即使经济身份未证也保留原生映射证据。

## 逐产品经济标的证明

每行同时依赖指定产品、官方资产的经济名称/项目引用及当前产品单位元数据。`contract-evidence.ts` 仅收录以下六个精确键，不能由熟悉的 ticker 自动扩展。

| 精确产品 | 经济身份来源 | 产品/单位来源 |
|---|---|---|
| Binance BTCUSDT | [Bitcoin (BTC)，链接 bitcoin.org](https://www.binance.com/en/price/bitcoin) | [exchangeInfo 的 baseAsset/quoteAsset/marginAsset/contractType](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information) |
| Binance ETHUSDT | [Ethereum (ETH)，链接 ethereum.org](https://www.binance.com/en/price/ethereum) | 同上；只接受 USDT margin 的 PERPETUAL |
| OKX BTC-USDT-SWAP | [Bitcoin BTC](https://www.okx.com/price/bitcoin-btc) | [官方 BTC/USDT underlying index、每张 0.01 BTC、每 BTC 的 USDT 价格](https://www.okx.com/en-au/help/i-perpetual-swaps)及当次 instId/ctType/ctValCcy/settleCcy |
| OKX ETH-USDT-SWAP | [Ethereum ETH](https://www.okx.com/price/ethereum-eth) | [instruments](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments)当次 linear SWAP、ctValCcy=ETH、settleCcy=USDT |
| Bybit BTCUSDT | [Bitcoin BTC](https://www.bybit.com/en/coin-price/bitcoin/) | [官方 USDT perpetual 指南明确 BTC/ETH 经济标的及 BTCUSDT/ETHUSDT](https://www.bybit.com/en/learn/trading/trade-usdt-perpetual-futures)和当次 LinearPerpetual/baseCoin/quoteCoin/settleCoin |
| Bybit ETHUSDT | [Ethereum ETH](https://www.bybit.com/en/coin-price/ethereum/) | 同上 |

Binance 资产页不是合约上市日证明；Ethereum 页上的跨链代币地址也不构成永续合约乘数换算。当前字段只用于证明指定产品的经济标的，不承诺成交数量或现金流等价。Aster、HL、HYPE 及其余币种的独立经济身份尚未收录，`underlying=null`；它们仍作为 unpaired 可见，不能进入候选。

## 费率口径与历史边界

[Binance](https://www.binance.com/en/support/faq/detail/360033525031)、[Aster](https://docs.asterdex.com/astherusex-orderbook-perp-guide/funding-rate)、[OKX](https://www.okx.com/en-gb/help/perps-funding-fee-mechanism)、[Bybit](https://www.bybit.com/en/help-center/article/Funding-fee-calculation)说明资金费按 mark price 对应持仓名义价值乘费率，归为 `linear-mark-notional-fraction`。Aster 官方 Funding Amount Calculation 明确用 mark price × contracts；这是口径证明，不是 Aster BTC 经济身份或历史周期证明。

[HL funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)明确按 position_size × oracle_price × funding_rate，故独立为 `linear-oracle-notional-fraction`，不得与上述 mark 组混排。[合约规格](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications)还说明 USDC collateral、USDT 计价及 HYPE/PURR 的特例，不推导汇率或现金流等价。

五场所当前产品说明均未补齐有生效起止时间的历史周期证据，生产 `rules=[]`、历史 UNKNOWN；HL 当前“每小时”描述不回填到时间零。Binance/OKX/Bybit 只有真实上市字段才生成 listing；Aster 字段缺失、HL 未证时均为 null。毫秒偏移也不按相邻事件或整点四舍五入反推；仅允许独立证明表中的 HL rawTime 映射。离线 fixture 的生效规则/上市/映射证明不是生产证明。
