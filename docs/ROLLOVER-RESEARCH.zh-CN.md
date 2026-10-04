# 展期官方规则研究

本文保留历史官方规则与公开市场来源，不保存账户持仓、资金、模拟金额或个人执行时间表。
以下是历史研究记录，不能代替当前规则和部署核验，也不构成交易授权。

## 账户核验方法

执行前在本机重新核验四腿身份、当前权益、各池 IM/MM、负债、结算消耗、Gas 和授权。
缺少合法更晚目标、完整报价、阶段保证金、完整退出成本或数值风险预算时，不得认定执行就绪。
Gate 与 Boros 的资金不能互相抵消；IM 管理余量可按“权益 − 管理覆盖率 × IM”计算。
实际批次取退出深度、入场深度、阶段资金、压力预算约束的最小值，不能把可用余额全部视为安全预算。
退出增量成本与历史损益分开；保证金释放不是新增收益。Gas 使用独立账本，禁止重复计费。

## 时间与证据边界

按各路径最后可操作时间倒推确认、执行、失败恢复及余量；不预设固定试批比例或固定耗时。
到期、结算完成、IM 回收、可提现与跨平台到账分别核验，不能共用一个完成标记。
真实账户快照及执行准备表只保存在本地私有资料中。

## 6. 官方规则证据

官方资料于 UTC 2026-10-04 19:39:42 左右采集；网页未显示发布日期。合约依据官方公开仓库提交 `78403bfe26d9a4c2cf8121726f4d6d9c1539009c`，源码不是已验证的当前部署字节码。本轮只读，不为验证规则而提交交易。

### 6.1 单笔 FOK、API 预检与链上整批保证

- [官方 CustomTypes / TimeInForce](https://docs.pendle.finance/boros-dev/Contracts/CustomTypes#timeinforce)：原文 “FOK (Fill or Kill): Must fill entire order size immediately (from order book + AMM) or the transaction reverts.” 单笔 FOK 全额即时成交或交易回滚；IOC 则允许部分成交。
- [官方 Backend API / requireSuccess](https://docs.pendle.finance/boros-dev/Backend/api#calldata-and-requiresuccess)：`requireSuccess=true` 的直接说明是整批先模拟，任一调用预计回滚，则在发送任何链上交易前拒绝整批；`false` 可分别执行、部分成功。这段 API 文案本身不是四腿链上原子证明。
- [官方 MiscModule.sol，固定提交第 38–57 行](https://github.com/pendle-finance/boros-core-public/blob/78403bfe26d9a4c2cf8121726f4d6d9c1539009c/contracts/core/router/modules/MiscModule.sol#L38-L57)：`tryAggregate(true, calls)` 对子调用逐个 delegatecall，任一失败通过 `_revertBytes` 使同笔交易回滚，包括此前状态变化。回滚仍可能消耗 gas。
- [官方 Router / bulk orders](https://docs.pendle.finance/boros-dev/Contracts/Router#bulk-orders)：bulkOrders 不匹配 AMM，placeSingleOrder 才支持订单簿与 AMM；不能把笼统的 FOK 文案理解为任何批处理自动使用 AMM。

本地展期入口使用官方构建器。实际四腿是否全部 FOK、是否属于同一笔原子调用、部署字节码是否一致，仍须针对候选目标核验；预检成功不替代 receipt/events 和实际仓位验收。

### 6.2 到期交易门禁与暂停

- [MarketInfoAndState.sol 第 70–72 行](https://github.com/pendle-finance/boros-core-public/blob/78403bfe26d9a4c2cf8121726f4d6d9c1539009c/contracts/core/market/core/MarketInfoAndState.sol#L70-L72)：成熟判据为 `market.latestFTime >= market.k_maturity`，不是直接比较 `block.timestamp`。
- [CoreStateUtils.sol 第 204–214 行](https://github.com/pendle-finance/boros-core-public/blob/78403bfe26d9a4c2cf8121726f4d6d9c1539009c/contracts/core/market/core/CoreStateUtils.sol#L204-L214)：要求检查 maturity 的路径拒绝成熟市场；要求检查 pause 的路径拒绝 PAUSED。
- [MarketOrderAndOtc.sol 第 32–43 行](https://github.com/pendle-finance/boros-core-public/blob/78403bfe26d9a4c2cf8121726f4d6d9c1539009c/contracts/core/market/MarketOrderAndOtc.sol#L32-L43)：交易路径同时启用上述两项检查。
- [CoreStateUtils.sol 第 166–168 行](https://github.com/pendle-finance/boros-core-public/blob/78403bfe26d9a4c2cf8121726f4d6d9c1539009c/contracts/core/market/core/CoreStateUtils.sol#L166-L168)：CLO 要求仅关闭订单或满足豁免。

所以已知道旧仓名义到期 T，也不能宣称它就是有成交保证的最后墙钟时刻。PAUSED/CLO 可更早改变操作能力；预留确认和失败恢复时间，不依赖结算滞后延长交易窗口。

### 6.3 结算、退出与可提现分别验收

- [官方 Settlement](https://docs.pendle.finance/boros-dev/Mechanics/Settlement)：预期约整点后 30 秒结算，特殊风险管理操作可造成延迟。采用 lazy settlement；NoSettle 读法可能返回未结算状态，官方 REST 提供当前数据且无需为读取而手动触发结算。没有固定 120 秒窗口或“到期+30秒必定完成”的保证。
- [官方 Router / exit markets](https://docs.pendle.finance/boros-dev/Contracts/Router#exit-markets)：退出要求仓位为零、撤销挂单、无待结算；到期后应退出以释放市场槽位。
- [官方 Router / withdraw cash](https://docs.pendle.finance/boros-dev/Contracts/Router#withdraw-cash)：提款是 request → cooldown → finalize，具体可提现时点查询 getUserWithdrawalStatus。

本轮未验证到期自动归零的精确分支、最终费用与抵押释放的时延、当前 cooldown。因此“到期”“结算完成”“IM 回收”“可提现”“跨平台到账”分别核查，不能共用一个完成标记。不追加资金的方案也不能依赖到期瞬间释放抵押品。

### 6.4 官方完整市场列表

[官方 API base URLs](https://docs.pendle.finance/boros-dev/Backend/api#base-urls) 指定当前 `https://api-boros.pendle.finance/apis/v1/`；旧 open-api 地址已弃用。

只读分页来源：

1. [markets?skip=0&limit=200](https://api-boros.pendle.finance/apis/v1/markets?skip=0&limit=200)：200 条，返回下一页 resumeToken。
2. [markets 第二页](https://api-boros.pendle.finance/apis/v1/markets?limit=200&resumeToken=eyJsYXN0TWFya2V0SWQiOjIwMX0)：24 条，resumeToken=null，同步时间 Unix 1791142742（UTC 19:39:02）。

共 224 条；HL/Binance ETH 最晚仍是旧 128/129 的 Unix 1798156800，209/210 是更早的 11 月 27 日期次。当前往更晚期展期的匹配目标数为 0；后续需重新获取完整分页，不沿用本快照。

## 复核入口

- 只读查询账户、持仓、资产与公开市场；模拟与执行分离。
- 复用 src/core/boros/rollover.ts、src/server/routes/borosPair.ts 和共享风险判定。
- 缺失、过期、覆盖不完整或身份不匹配的证据保留 UNKNOWN。
- 本文不保存交易哈希、钱包标识、账户金额或原始响应。
