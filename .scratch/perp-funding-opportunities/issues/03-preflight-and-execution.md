# 预填、重报价与两腿执行边界

Type: grilling
Status: open
Assignee: none
Blocked by: 01, 02

## Question

在保留ETH/BTC/HYPE与同计量单位执行边界的前提下，从机会到已有PairTicket/preview/ExecuteControl/deal，应传哪些意图、允许编辑什么、用哪些最新证据阻断下单？

用户已确定人工逐笔确认、复用maker＋hedge，不在本票设计自动择时。需决定所选历史证据与确认时盘口/账户证据的身份关联、改规模/杠杆或方向后的重报价，以及执行中刷新页面如何继续显示真实状态。

### 讨论建议（尚未定案）

用现有prefillPair接已有预览确认门；交易币种/单位/lot/minimum、余额/权限、已有反向净仓冲突均由权威校验裁定。新的机会入口不能放大现有未知数据的允许范围。800ms确认、防重复client id、unknown隔离和单writer保持；不声称跨腿原子。DONE带dust、部分成交与stopped应可识别。

### 验证本决定的例子

预览10秒后行情变化；同一意图网络超时重试；maker部分成交+B拒单；ETH同单位步长不兼容；1000/k合约只观察；已有反向净仓使新单先减旧仓。

### 输入

[执行复用核查](../evidence/execution-reuse.md)。

## Comments

- 2026-10-27：wayfinder初始建图，未认领、未解决；讨论建议不是用户已确认决策。
