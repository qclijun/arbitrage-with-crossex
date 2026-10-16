# 对冲依赖与缺价等待

9 号票提供独立、默认关闭的 Maker 等待优化；不改变原有交易风险政策。
生产 LoopDeps 不自动开启它，不读取环境变量启用。07 真实基线、06 RSS 和最终组合
验收仍未通过；后续受控接线由 10 号票承接。本次没有部署、重启或访问真实账户。

## 等待优化

内部选择为 `LoopDeps.skipUnrelatedMakerWait = true`；false/undefined 恢复原 Maker→B
读取顺序。它与 8 号票的签名连接池独立。切换不打断已开始的请求，也不新增写者。

启用后，如果已确认存在需要 B 参考价的义务，先尝试 B 价；取得有效参考价后再次
观察订单并重算投影。任何 await 中 Stop、Convert、改价、报价模式或参考价模式变化
都会使本 tick 上下文整体失效，下一 tick 才用新意图重算。
这次额外订单确认会增加只读负载，必须进入最终频率、排队和资源验收，不能为凑样本加速。

`decideBeforeMakerPrices` 与正常 `decide` 共用同一个纯决策函数，执行完全相同的
取消、冻结、模式切换、hedge sizing 和 backoff 优先级；仅在 OPENING 确实要消费
Maker 行情或 CONVERTING 要消费新 A clip 参考价之前停下。返回 null 才读取 Maker；返回动作则说明该动作不依赖 Maker。
最终动作仍由完整 decide 决定，并且只调用一次 perform。

因此不是凭“有未预留义务”直接发 B，不是 Promise.all 后继续等待所有行情。
无需 Maker 时连该次 Maker 请求都不启动；需要 Maker 时仍使用原源/原定价规则。
取消、UNKNOWN/PENDING/quarantine、写前登记、一次 tick 最多一次交易写及跨 deal
调度保持。只有未预留数量能产生新的 B；已预留量与实际成交量不混用。

缺失的必需 B 价保持 null，不能用未使用价格的 '0' 哨兵、保留旧价或备用源绕过
minNotional。现有适配器有效性约束继续适用；启用路径拒绝非正参考值。
数量继续十进制定点并向下取整；sub-lot/sub-minSize dust 不计缺价失败。
原失败预算、3s 退避及 HALTED 慢重试保留；B 价恢复不自动重新开放 A 获取。

## Maker 故障独立保留

跳过 Maker 时，不创建、清除或重置 bookOutageStartedAt；B 参考价恢复也不代表
Maker 恢复。下一次真正需要 Maker 行情的 tick 才按实际结果继续维护 outage。
原 30 秒规则在其既有条件下继续生效：订单可读、当前确实采到 Maker 缺价后才能
触发相应撤单。优先级更高的对冲仍按原 decide 顺序先处理。
2 tick、15 秒、20 次、绝对期限、经济性及四腿适用范围均未改变。

## 等待报告

缺价诊断沿用 SQLite alert 与可选 EngineObservation，不新增通知系统。
它独立于等待优化开关；关闭优化后仍可看到缺价，但读取顺序恢复原样。
诊断状态只用于报告，决不能决定是否重新确认订单、下单或解锁交易。

首次发现整 lot/minSize 可提交的未预留义务因必需参考价受阻时报告一次。
持续最多每 30 秒报告一次，结束时报告原因；existing backoff 本身不制造一个新缺价 episode。
报告包含未预留基础币数量、局部订单证据可验证的已确认净成交数量及进程内观测等待时长。
B 已预留未成交不代表实际已对冲；读失败、PENDING 或 quarantine 时数量为 UNKNOWN。
即使数量可验证，也只是本 deal 的本地累计确认口径，不是全账号即时经济暴露。

结构化 `hedge-wait` 状态：

| 状态 | 含义 |
| --- | --- |
| blocked | 必需 B 参考价缺失 |
| recovered | B 参考价可用，其他冻结/模式/退避仍生效 |
| not-required | 没有可提交的未预留义务；不表示源恢复或实际暴露为零 |
| unverified | 订单、价格或报告证据不足，不能确认恢复 |

新增字段 `waitMs`、`waitState`、`actualUnhedged` 与已有 unreserved 分开。
waitMs 使用单调时钟，UTC 独立锚定；回退/非有限的诊断时钟使时长 UNKNOWN。
进程重启后不能重建停机前的等待，只报告本进程观测片段；完整等待时长 UNKNOWN。
源原始时间、跨 venue 钟差和真实经济暴露仍 UNKNOWN，缓存命中/本地组装/成功响应
均不证明源新鲜度。没有新的年龄门槛、应急平仓或“等够时间就绕过”政策。

诊断使用每 Store 至多 256 个 active wait；结束/DONE 后释放，Store 可被 GC。
超额不驱逐旧状态以伪造新起点，会产生容量 UNKNOWN 告警及缺证明细。
容量告警共用每 Store 一个节流锚点，至少间隔 30 秒；确认告警不重置节流，
时钟回退或非有限时不重复上报，首次时钟无效则无法证明经过时间而抑制重复。
这不是新的交易恢复状态，不影响账本系统记录。明细仍通过 06 的有界 worker 和保留规则
写出；告警写入异常被隔离，不能阻止安全对冲。额外同步告警开销仍需最终测量。

07 的 `latency_report.py replay` 输出新增 `hedgeWait`：按 run/deal 选择最新等待状态，
保留缺失字段为 null，confirmedUnhedgedBase 与 unreservedBase 分列；经济暴露和源时间
状态仍 UNKNOWN。历史 v1 文件缺少新字段仍可重放。

## 离线验证

```sh
yarn typecheck
yarn vitest run --project unit tests/unit/engine-hedge-dependency.test.ts
python3 -m unittest discover -s tests/latency -v
```

引擎测试使用真实临时 SQLite、现有 VirtualClock 和受控 Venue；可控 promise 证明
B 不等待 Maker，未用墙钟 sleep 或真实账户造单测速。包含额外确认期间新成交、取消竞态、
意图变化、冻结/backoff/HALT/dust、旧 outage、预留未成交、报告节流/容量/写失败及钟差。
只有实现/离线证明完成，真实收益和测量准入尚未验收。
