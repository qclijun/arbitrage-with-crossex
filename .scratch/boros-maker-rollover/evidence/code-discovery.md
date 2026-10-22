# Boros Maker 展期：当前代码能力核实

日期：2026-10-22。只读代码核实；未访问账户、未读取 .env、未交易、未改仓库文件。

## 会影响方案边界的结论

- **当前原子展期固定 FOK Taker。** `src/core/boros/rollover.ts:545-568` 的 `submitBorosRoll` 把 closes 和 opens 放进同一批，552-553 行明确 `timeInForce: 'fill-or-kill'`。两旧腿、两新腿形成四腿同批；这是已实现的四腿原子 Taker 路径。
- **当前 Boros 写端口没有 resting/postOnly Maker。** `src/core/boros/orders.ts:194-234,236-261` 提供 market-order batch、roll simulation、cancel；257 行 TIF 仅 IOC/FOK。`src/core/boros/borosApi.ts:108-115,800-816` 映射 IOC=1/FOK=2。`563-586` 的 place-order DTO 带 rate/tif/ammId=0，无 postOnly。rate 是最差 APR 边界，不能把有 rate 当成已有 Maker。
- 因而已审阅的 Boros 写端口及 roll 路径没有四腿原子 Maker 实现。这不能证明协议绝对不支持；尤其单次交易的 acceptance 原子性不等同等待挂单后四腿最终成交原子性。

## 部分成交与原子性

- `orders.ts:194-214` 区分全批 acceptance 与 full fill：IOC 部分成交仍成功，各腿可能不等量。`borosApi.ts:1011-1043` 按 call index + market 累计事件成交、报告 shortfall，用 dust 容差避免浮点伪剩余；事件无真实 execApr/fee 时返回 null。
- `borosApi.ts:434-444` 调 `/v1/send-txs/bulk-calls`，多调用 requireSuccess=true；`952-975` 任一明确拒绝报告整批失败。这是代码采用的原子性语义，服务/合约在当前部署的保证仍需官方资料确认。
- `rollover.ts:479-522` 对应旧腿精确 sizeWei 复制给新腿；支持 singles/spread 不同腿数。`570-598` 只把所有 FOK 腿全填视为 rolled；缺结果、unknown、违反 FOK 的部分成交组合均 unknown，并提示查仓后重发。
- `borosApi.ts:850-886` 调 `/v2/simulations/roll-over`，整体 preview closes/opens/撤单/市场退出；`rollover.ts:233-458` 根据该 preview 判断 FOK 流动性与先平后开的保证金。没有 Maker 等待、队列、重报价仿真。

## Resting 识别与撤单确认局限

- `src/core/boros/client.ts:177-206` 可读 hasRestingOrders。`src/server/routes/borosPair.ts:1143-1144` 识别旧市场 restingOrderMarkets 并传 cancelOrdersOn；`borosApi.ts:809,917-930` 把取消与 closes/opens 同批。`orders.ts:250-256` 约定拒绝 close 时同时不撤旧单。
- `borosApi.ts:630-641` 构建每市场 cancelAll=true，非单笔 Maker 生命周期管理。
- 独立 `borosApi.ts:1050-1080 cancelOrders` 检查非空提交返回、明确 error；空返回报 cannot tell whether it landed。有 gas top-up 时轮询 gas credit。
- **该独立 cancel 未见 tx hash 最终 tx-status-with-events 或撤后 open-orders 清零确认。** 非空、无 error 的提交响应即可返回成功（另有 gas credit 等待）。不能将其认定为已最终撤净的完整 Maker cancel handshake。

## Unknown 与恢复

- `borosApi.ts:451-467` 有限次按 txHash 轮询 tx-status-with-events，未解决返回 null。`935-943` 将 4xx 当门口拒绝，5xx/timeout/断连传播不确定；`978-1009` 无 txHash、无状态、缺某腿状态均 unknown，不当作零成交。
- `rollover.ts:554-565` catch 转 unknown，要求查 Boros 仓位后再重发。
- `borosPair.ts:100-113,421-446,680-705,1205-1215` 有约 10 分钟进程内 replay memo：同 IDs 返回原结果；unknown 保留、明确全拒绝可重试。注释明确 clientOrderId 不受 venue dedupe，重启或第二进程无保护。
- **不能把 docs/MAKER-HEDGE.md 的 SQLite 注册、持续 pending probe、单 writer 恢复梯子自动等同此 Boros panel 能力。** 本路径可见的是有界 tx-status 查询 + 进程内 memo + unknown 人工查证；没有已核实的跨重启 resting Maker 订单恢复。

## 必须由官方资料补证的协议问题（本次未联网）

1. GTC/postOnly 正式枚举、crossing 行为、rate/tick 取整。
2. 四腿能否创建 resting orders；requireSuccess 约束原子建单还是未来成交；有无原生 contingent/OCO/roll Maker。
3. Maker 部分成交事件、order ID/累计成交、单笔撤单、cancel 最终性和撤单与成交竞争的权威读数。
4. txHash/nonce/client ID 的持久查证与 timeout/5xx 去重语义。
5. Maker 实际费率/返佣资格与资金费、保证金规则；净节省不能以挂单报价代替实费和成交成本。

## 验证与交接

目标是为现有持仓展期划定可实施边界。已确认当前后备为单批 FOK 原子 Taker；Maker 必须先通过协议、部分成交和恢复证据门槛，不能假设已有撤净确认或跨重启去重。本次无代码提交、无测试运行，完成 graph 搜索、submitBorosRoll 双向 trace、关键 snippet 和当前源码复读，证据为本文所列路径行号。后续先补官方协议保证，再设计受既定资金费缺口与过覆盖上限约束的实现和验收；未满足前保持当前 Taker 路径。

Graph generation：2026-10-21T15:23:38Z。coverage：rollover.ts、orders.ts、borosApi.ts、borosPair.ts、venue.ts、client.ts 均 no_recorded_issue / metadata_match；src/core/boros 与 borosPair scope 无记录缺口，无分页剩余。该信号为 best effort，非全仓完整性证明；关键结论用当前源码验证。
