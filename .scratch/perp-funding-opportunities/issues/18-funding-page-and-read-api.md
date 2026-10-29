# A排名工作台与只读机会API接线

Type: task
Status: claimed
Assignee: Claude
Blocked by: 05, 09, 10, 19

## Goal

按用户已验收[A原型](../page-prototype.md)实现正式只读机会页及API，先交付观察能力；不直接提升原型代码，不提前接通开仓。

## Scope

- 升级Funding Spreads独立入口，左侧全有向排名表、右侧连续详情，保留四腿/三腿入口及Positions/Risk导航。默认30天＋7天对照、五窗口、币种/场所过滤、稳定分页和可选正值过滤；零/负/反向保留。
- API只读09已发布缓存和10候选，不因浏览器请求采集外网；绑定共同cutoff、窗口、snapshot、精确腿身份和排序。展示两腿累计/年化、当前原始费率/周期及反转提示，不自动换向。
- 缺期、失败、周期未证明、stale、仅观察、白名单/单位限制等可解释。UNKNOWN与不支持区分；局部失败不阻完整组合。冷启动无数据、刷新失败保留旧证据及原时间，不伪造完整市场覆盖。
- 观察阶段人工开仓关闭，明确说明未启用；无快捷跳转普通pair绕过。消费19的服务端状态，禁用不只依靠UI。此阶段不宣称11—17已完成；未接好成本区域显示不可用/UNKNOWN，后续11/13接金额与确认。
- 18负责页面/只读API；10只管领域候选/排序。13负责可执行票据和成本/确认接线，14负责持久执行恢复，17负责认领/归因交互；不要在18另做执行器或归属账。

## Acceptance

离线server/UI验证A布局、三场所六方向、同venue多合约、过滤分页、固定方向、缺失/零/负及stale。server只用app.inject、fake数据且阻止真实HTTP；浏览器用隔离fixture/stub环境，证明无真实交易API及页面触发外网采集。与19联合证明观察阶段伪造请求也不能新开/加仓，原四腿/三腿入口无语义偷换；不把按钮禁用当服务端证据。默认verify及web build通过，保存实际页面截图和提交/命令；只读阶段验收按[实施计划](../implementation-plan.md)，不自动开启交易。

## Comments

- 2026-10-27：06已确认Q1先只读交付及05选择A；补齐原07—17未完整承接的页面/API责任。仍等待06最终共同理解确认，不可认领实施。
- 2026-10-27：用户最终确认06共同理解，06已resolved并解除本票对应阻塞；其余依赖及验收要求不变，不自动认领、启用或部署。
- 2026-10-29：用户确认范围与接缝并claimed：真实官方历史适配器及合约标的/费率口径证明映射另开[22](22-history-adapters-and-contract-identity.md)，18只做A页、只读API、端口及index接线（来源为空时如实冷启动/未接线）；旧当前费率表保留为折叠次级视图；跨页以排名指纹`rankingId`（真实now评估，变化即回第1页并提示）；当前费率由后台轮询feeds.ts入内存，API只读内存。测试接缝：`GET /api/funding/opportunities`（app.inject）、`createFundingMarket`与feeds原生contractId、`FundingOpportunitiesPanel`（msw）。
