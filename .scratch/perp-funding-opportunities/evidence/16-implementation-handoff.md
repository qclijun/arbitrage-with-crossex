# 工单16实施交接

目标：[Risk适用契约](../risk-applicability.md)。用户确认接缝（2026-10-28）：资金费覆盖仍按`base:venue:side`来源；应覆盖量＝实际永续量−已证明浮动量；已证明浮动量只来自funding-two-leg切片，每切片只按min(多腿,空腿)，两腿合约须在本次新鲜读数上对账、切片证据≤12秒，否则不豁免；boros-hedge不豁免；价格/保证金/清算/执行风险不变。Python独立ETH连续缺口链使用报告（版本2）附带的同一豁免清单并纳入指纹（空清单指纹不变），仅豁免变化且剩余缺口不增时保留起始时间。四腿按来源汇总，明细注明未证明逐策略覆盖。

## 交付

- `web/src/lib/fundingApplicability.ts`（纯）：`floatingApplicability(slices, legs)`按上述规则产出每来源豁免量、说明及授予清单；切片声称超过本报告持仓读数时该来源不豁免并说明。
- `web/src/lib/accountRiskSources.ts`：`hedge.funding_gap_ratio/usd/material_gap_ratio/unmatched/quantity_verified/direction_match`、`rollover.uncovered_funding_eth/seconds`、`hedge.*_size_gap_eth`以应覆盖量计算；明细写“intentionally floating …（slice …）”及“coverage judged per source, not per strategy”；连续缺口指纹纳入ETH豁免。`hedge.residual_*`、IM/MM/清算、Boros抵押等未改；规则/阈值未改。
- `src/core/risk.ts` `fundingGapFingerprint`可选`floating`，有豁免才加入身份（排序与Python一致）。
- `src/server/routes/riskReport.ts`：读取`/slices`（失败计入errors、报告不完整），报告`version: 2`，`collection.fundingApplicability`为授予清单。`web/src/api/sliceQueries.ts`＋`RiskPanel`同样读取切片（每5秒），页面与报告同一计算。
- `scripts/risk_monitor_funding_gap.py`（由`risk_monitor.py`拆出并重导出）：`record_funding_gap`使用报告豁免（不自行推导、不放大），格式错误或超过所持腿即不记历史；指纹与终端逐字节一致（测试钉住同一字符串）；`collect_report`接受版本1/2，版本2须带豁免清单。

## 验收映射

已认领完整浮动两腿无Boros→`funding_unmatched`为false、浮动可见、净敞口仍计算；A满B部分→仅min部分豁免，单腿缺口仍在；对账非reconciled、证据超12秒、boros-hedge→不豁免；超出持仓→不豁免并说明；4.03中0.36有Boros、3.67已证浮动→覆盖OK，未认领→CRITICAL；过覆盖来源仍为缺口；HYPE等非ETH/BTC仍使producer不完整（未改）；原CRITICAL在证据缺失时由既有规则保持；Python版本/指纹/计时。

## 验证

新测试：`web/src/lib/fundingApplicability.test.ts`（10）、`tests/server/risk-report-floating.test.ts`（1）、`tests/monitor/test_funding_applicability.py`（6）；风险报告测试夹具抽至`tests/server/helpers/risk-report-fixture.ts`。tsc（root/web）通过；root unit/server 3451通过/8跳过；web `src/lib`＋RiskPanel 362通过；`tests/monitor` 149通过、`tests/screening`通过；文件预算通过。

## 限制

- 同一来源内多组四腿的过/欠覆盖无法逐策略区分（Boros腿未按策略归属），按来源汇总并明示。
- 豁免依赖15的对账：任一腿合约未对账即全部失效，资金费告警回到旧语义（保守）。
- 页面切片证据须≤12秒（用户确认），轮询5秒；网络迟滞时豁免可能间歇失效而显示旧告警。
