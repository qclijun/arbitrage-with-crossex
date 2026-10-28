# 按切片数量限定Risk适用范围

Type: task
Status: resolved
Assignee: Claude
Blocked by: 04, 15, 20

## Goal

实现[Risk适用契约](../risk-applicability.md)：仅对可证明的浮动两腿数量解除Boros覆盖要求，保留真实浮动资金费暴露及其它全部风险。

## Scope

- 从15读取完整、可对账的归属证据，贯穿producer、metric/适用性契约、evaluateRisk、API/UI和监控；不得仅凭客户端策略标签禁用规则。
- 四腿、三腿Spread、未归属和冲突数量继续按实际资金费腿检查。Spread物理仓/资金/收益只计一次，风险来源展开不重复认领；一处超覆盖不能掩盖另一处缺口，不拆dust绕过原规则。
- 价格对冲、保证金/清算、账户资金与执行unknown照常校验。已证明的有意浮动不得伪造为Boros覆盖或物理缺口为零；旧CRITICAL不能因改标签或证据缺失清除。
- 明确账户/资产/来源/单位/方向/时效/完整性及版本。HYPE等现有producer缺口应补足证据或保持UNKNOWN；不默默排除，不把不支持写成不适用。旧basis/rollover限制不能自动泛化为浮动两腿锁定收益。
- 同步公共risk report的Python消费者及独立ETH资金费缺口历史链；未知/不支持不能重置持续缺口计时为零。版本化历史语义，不混用旧样本与新适用性。
- 不改通用阈值，不全局关闭资金费告警，不增加自动交易；具体当前缺口见[核查](../evidence/risk-applicability-review.md)。

## Acceptance

离线producer→report/UI/monitor契约测试覆盖：已证明两腿仍有价格缺口；4.03中0.36持有Boros、3.67分别未归属或已证明两腿；Spread双来源与物理单计；错方向/超覆盖抵销；来源过期/不完整、HYPE不支持、场外差异；原CRITICAL遇UNKNOWN；监控版本及持续缺口计时。确认只豁免相应数量的Boros要求，其它风险无回归；仅fake数据与app.inject，相关Python标准库测试另运行。最终yarn verify和web production build。

## Answer

2026-10-29用户签收。实现5bb7d06＋788e03b：资金费覆盖仍按`base:venue:side`来源，应覆盖量＝实际永续量−已证明浮动量；已证明浮动只来自funding-two-leg切片的min(多腿,空腿)，两腿合约须在本报告同一持仓读数上对账、证据≤12秒，否则不豁免、旧告警保持；boros-hedge不豁免；价格/保证金/清算/执行风险及阈值不变；明细标出有意浮动及“按来源、非逐策略”。Risk报告版本2携带授予清单（无法当下证明时为null即UNKNOWN，切片读取失败不令报告不完整）；页面同算。Python连续缺口链拆至`risk_monitor_funding_gap.py`，使用报告豁免、精确十进制、与终端逐字节一致的指纹，豁免UNKNOWN时历史不延长不重置，新增豁免不重置剩余缺口计时。限制：同来源内多组四腿逐策略覆盖无法区分。默认verify仅`App.setupOnce`既有偶发失败（归21），build通过。详见[16实施交接](../evidence/16-implementation-handoff.md)。不启用交易。

## Comments

- 2026-10-27：04决定后预拆，等待06及15，当前不可认领实施。
- 2026-10-27：06-Q4/Q6已确认：按20兼容协议版本化Risk/历史语义，producer到Python consumer的变更另跑相关monitor/screening suite；旧CRITICAL/缺口计时不因新标签或UNKNOWN清零。正式跨票验收由21汇总，不以旧原型测试替代。
- 2026-10-27：用户最终确认06共同理解，06已resolved并解除本票对应阻塞；其余依赖及验收要求不变，不自动认领、启用或部署。
- 2026-10-28：用户确认接缝（min两腿且同读数对账≤12秒才豁免、报告版本2携带清单供Python链、四腿按来源并标注限制），claimed并实施；双轴审查后修正Python浮点、切片读取失败/证据失效时的计时处理及读数绑定。
- 2026-10-29：用户签收，追加Answer并resolved。
