# 降低盘口与执行延迟风险决策地图

Labels: wayfinder:map
Progress: resolved
Updated: 2026-10-16 Asia/Taipei

## Destination

形成可交给实现阶段的首期方案与验收标准：缩短 Maker 已成交后的未对冲暴露时间，保持不重复获取、不超额对冲、不依据无法确认的订单结果行动。
终点是风险取舍、改动边界、验证与回退方案均明确；本地图不实施产品代码或实盘操作。

## Notes

- 用户已确认：未对冲暴露时间优先，POC 拒绝率和建仓耗时为次要指标；首期审查连接复用、链路计时和对冲路径，WebSocket 单独后续评估。
- 沿用当前单写者、每 tick 最多一次交易写请求、先确认订单再替换、已确认成交优先 Taker 对冲、UNKNOWN 探测而非猜测，以及现有 Post-only 保护。
- 既有改价规则和账户策略见 [已有报价决策](../../docs/adr/0001-four-leg-perpetual-touch-quoting.md)。本次审查不默默改变其范围、2 tick/15s/20 次/绝对期限或经济性约束。
- 每次会话先使用 wayfinder 与本地 tracker；人工取舍使用 grilling、domain-modeling；外部证据使用 research；结构定位使用 codebase-memory，并验证覆盖。
- [本机延迟诊断](../four-leg-maker-requote/book-latency-2026-10-16.md)与[实盘验收](../four-leg-maker-requote/live-validation-2026-10-16.md)是输入证据，不是已批准的设计或上线验收。
- 只读查询提速不能直接证明下单提速；源快照年龄、请求往返、缓存驻留、报价在途、实际暴露时间必须区分。
- 子票按 `issues/` 中 Type、Status、Progress、Assignee 和 Blocked by 查询。Status 是分诊；Progress 是开放/认领/解决。人类决策未经用户回答不得 resolved；地图不存放完整答案。
- 2026-10-16：首期决策均已完成，地图达到方案交接终点；resolved 不表示产品已实现或验收通过。各票 Answer 为详细结论，后续实现遵守其门槛；本地图不执行实现或实盘验证。
- 2026-10-16：已综合为 [首期实施规格](spec.md)，标记 ready-for-agent，供后续拆分实现工单；决策历史与详细研究仍由各关联票保留。

## Decisions so far

- [CrossEx 连接复用能改善哪些等待，且会引入哪些风险](issues/01-transport-evidence.md)：已核验安装代理的连接生命周期与 SDK 共享范围；研究为后续范围决策及验收提供证据。

- [哪些时间证据能证明行情新鲜度和未对冲暴露改善](issues/02-freshness-and-exposure-evidence.md)：已明确分段计时、真实成交与预留的区别，以及跳过读取必须保留的状态约束，为失效政策和验收提供证据。

- [首期连接复用覆盖哪些客户端与操作](issues/03-transport-scope.md)：用户确认引擎专用签名池、先计时后池化，以及路径、生命周期、资源取值门槛与显式回退边界；真实写请求收益待验收。

- [行情失效时如何减少获取风险并履行已成交对冲义务](issues/04-hedge-and-stale-policy.md)：用户确认保留既有失效政策、仅消除当前 deal 的无关行情等待；对冲缺少必需参考价时保留校验并报告等待，恢复后按最新订单与意图自动继续。

- [用哪些验收证据决定首期方案可以进入实现](issues/05-acceptance-and-rollout.md)：用户确认阶段准入、对照采样与预算、安全失败及独立回退、观测保留与资源边界；实盘收益仍须后续自然交易证据。

## Not yet specified

- 无首期方案交接前仍需解决的决策。原列出的首期实测后瓶颈及 WebSocket 路线依赖实施后证据，属于终点之后的后续工作，移至 Out of scope；本地图不把待测参数或尚未证明的收益视为已验证事实。

## Out of scope

- 本地图期间改代码、部署、重启、发单、撤单、转账或人为制造断网/拒绝；真实成交验证只安排在后续已授权的计划交易中。
- 以取消 Post-only、改成两腿 Maker、增加杠杆或扩大测试资金降低拒绝次数。
- 把历史 4 次 POC 拒绝全部归因于盘口延迟，或把已有只读测速结论当作真实下单的保证。
- 首期直接实现 WebSocket、自建行情节点或跨区域迁移；后续设计若需要，另建决策入口。
- 首期实测后的新瓶颈、调度或数据源投入路线，以及 WebSocket 对活动订单的覆盖取舍：均在本地图“首期方案与验收标准交接”终点之后，待后续证据成熟另开地图，不作为本地图未完成决策。

## Implementation follow-up

- 2026-10-16：[06 分段观测](issues/06-engine-latency-observation.md)已实现并完成离线功能验证，但保持 claimed：正常 GC 稳态 RSS 门禁未在三组全部通过。无观测的同次数 Store 读取也复现内存台阶，具体责任仍 UNKNOWN；不得据此默认通过。详见 [验收报告](../../docs/validation/engine-observation-2026-10-16.md)。

- 2026-10-16：[07 原路径基线与报告](issues/07-baseline-and-readonly-report.md)工具已实现，被动索引既有明细并离线重放；整票保持 claimed。06 RSS 准入及真实三组只读基线未通过，冷热/排队/实际成交钟差缺证为 UNKNOWN，未解锁优化启用。见 [使用说明](../../docs/LATENCY-REPORT.md)。

- 2026-10-16：[08 引擎专用签名池](issues/08-engine-signed-transport-pool.md)默认关闭的有界传输与退役生命周期已实现，候选 1/4/8 完成合成本机验证。真实基线/RSS/最终连接数仍 UNKNOWN，保持 claimed；不启用或重启。见 [使用与证据](../../docs/ENGINE-SIGNED-POOL.md)。

- 2026-10-16：[09 对冲依赖与缺价等待](issues/09-hedge-dependency-and-wait-report.md)默认关闭的离线实现已完成：共用纯决策判断 Maker/A clip 依赖，B 价后重新确认，等待报告沿用现有告警并有界节流。27 项新增引擎测试及双轴复审通过，Progress 保持 claimed。真实测量门禁保持 UNKNOWN；见 [说明](../../docs/HEDGE-DEPENDENCY.md)。

- 2026-10-16：[10 独立及组合验收与回退](issues/10-comparison-gates-and-rollback.md)完成四配置报告、参数/单代与退役高水位绑定和在途回退离线证明。真实测量仍缺证，Progress 保持 claimed；自动启用始终 false。见 [验证记录](../../docs/validation/engine-optimization-rollout-2026-10-16.md)。
