# 工单18实施交接

目标：按已验收A原型交付正式只读机会页与API，先交付观察能力，不接通开仓。用户确认（2026-10-29）：真实官方历史适配器及合约标的/费率口径证明映射另开[22](../issues/22-history-adapters-and-contract-identity.md)；旧当前费率表保留为折叠次级视图；跨页稳定用排名指纹；当前费率后台轮询入内存。接缝：`GET /api/funding/opportunities`（app.inject）、`createFundingMarket`＋feeds原生contractId、`FundingOpportunitiesPanel`（msw）。

## 交付

- `src/core/funding/feeds.ts`：每行带场所原生`contractId`（BTCUSDT、ETH-USDT-SWAP、kPEPE…，即历史接口所用键）及原文十进制`rateText`（JSON数字指数形式展开为十进制）。
- `src/core/funding/market.ts` `createFundingMarket`：后台读取22提供的已证合约清单及其所在场所的当前费率feed入内存，`view()`只读。无合约来源即`unwired`且零读取；只轮询清单内场所；读取失败或feed为空保留上次报价及原时间并具名（`network`/`empty`/`no-feed`）；不再列出的场所报价丢弃。报价超过自身一个周期由10的`inPeriod`排除。
- `src/core/funding/ranking.ts`：`fingerprint`＝sha256（snapshotId、窗口、过滤、全部过滤后行的顺序与是否排名）。
- `src/server/funding/board.ts`＋`routes/fundingOpportunities.ts`：只读09缓存＋内存市场，10枚举/排名，以真实now评估。查询`days/compare/underlying/venue/positive/offset/limit(≤200)/rankingId`严格校验，越界400不夹值。`rankingId`与当前指纹不符即`rankingChanged`并返回新排名第1页。行含精确两腿（含CrossEx symbol或null）、五窗口（净累计/年化、两腿累计/年化、coverage、原因、核验时间、缺失/冲突计数）、当前一期对照及反转提示、执行限制（`coin-unsupported`、`side:symbol-unmapped`、`side:unit-unsupported`，不影响排名）。另返回过滤选项、缓存视图（冷启动/cutoff落后/上轮失败及原发布时间）、合约状态与未配对原因、feed状态及19准入状态。端口缺失503。
- `src/server/funding/services.ts`＋`index.ts`：生产接线同一缓存、09刷新器（来源为空）、市场轮询器（无合约来源）、12的`history`/`legOf`；listen后启动、关闭时停止。22接入前页面如实显示未接线，零外网读取；12预览因符号未证/冷启动给出阻断。
- web：`FundingOpportunitiesPanel`替换Funding Spreads页内容——过滤条（五窗口、币种、场所、只看正利差）、左侧有向排名表（排名/观察、STALE/UNKNOWN/UNSUPPORTED/PARTIAL、仅观察、当期反转；未合格值去色）、分页、未配对合约折叠列表、右侧详情（固定方向、五窗口表、当前报价及读取时间、执行限制、成本与规模UNKNOWN、无开仓入口，仅跳转Positions/Risk）。状态提示：人工开仓未启用、未接线/清单读取失败、冷启动、cutoff落后、刷新失败及原时间、feed失败。旧当前费率表折叠于底部，展开前不挂载、不请求。百分比按十进制移位精确显示，非零小值不显示为0.00%。

## 审查

双轴审查。标准轴无硬违背；修正：空feed被当成功并清空报价（先红后绿，与旧路由同义判为`empty`）、`HISTORY_DAYS`三处硬编码、`pct`重复、listings判定重复（`readyListings`）、与旧路由同名`FundingFeedStatus`改为`MarketFeedStatus`、复用`isSupportedCoin`、命名（`boardWindow`、`selectedLegs`）。未改（判断项）：`VenueFundingRate.rate`浮点为既有字段（新代码只用`rateText`）；原因码沿用10的`side:code`字符串约定；`micro`样式常量与既有面板同型。规格轴修正（先红后绿）：状态列把UNSUPPORTED/PARTIAL写成UNKNOWN；`toFixed(2)`使HL小费率及小净值显示为0.00%；当前报价不显示读取时间；首次清单读取失败显示为“尚未读取”；补伪造旧客户端开仓（400`client-outdated`）。FX不另设页面阻断：混合计价在12预览时取证，详情注明费用/FX/保证金/持仓仅在预览检查。

## 验证

新测试：`tests/unit/funding-market.test.ts`（5）、`tests/server/funding-opportunities.test.ts`（11）、`funding-opportunities-evidence.test.ts`（8）、`web/src/panels/FundingOpportunitiesPanel.test.tsx`（7）；夹具`tests/helpers/funding-board-fixture.ts`、`web/src/test/fundingBoard.ts`；feeds测试补身份断言，hidden-tab轮询表改为新端点。覆盖三场所六方向＋同venue两合约、真同分、零/负/UNKNOWN、过滤分页全局名次、指纹变化回第1页、stale保留原时间、跨整点、冷启动、未接线零读取、未配对、执行限制不改名次、当前反转不换向、请求零来源读取零写入、准入关闭时伪造preview/intents/`funding-two-leg`/旧客户端均被拒且无场所调用。

最终默认`yarn verify`退出1：tsc、文件预算通过，root 166文件3534通过/8跳过；web 1/1737失败——`App.test`“settings after an update > opens settings once”，即12/19/20记录的同名偶发项（主机负载≈26），日志`/tmp/ticket18-verify3.log`；此前一次默认运行失败项为`App`用户指南（`/tmp/ticket18-verify.log`），均为既有偶发；`App.test`单跑20/20通过（仅诊断）。本票改动App仅替换funding面板，App测试中未处理请求计数与改前`/api/funding-spreads`相同（45）。`yarn --cwd web build`退出0。归21查因。

## 浏览器证据

隔离stub：`/tmp/ticket18-shot-serve.mts`以`buildApp`加载合成历史（`tests/helpers`夹具）、内存市场与假凭据，nock禁止外连、全局fetch拒绝，仅服务`web/dist`；headless Chrome打开`?tab=funding`。截图：[ready](18-page-ready.png)（排名、详情、当前反转、OKX feed失败）、[stale](18-page-stale.png)（17分钟后：全部STALE去色、刷新失败及原发布时间）、[unwired](18-page-unwired.png)（无映射：未接线、无候选）。右上“New here?”为既有首次引导。数据全部虚构，不连接运行终端或真实交易API。

## 限制

- 22接入前生产无候选：官方历史适配器、合约身份映射及其接线由22承接。
- 成本/规模/确认由11/13接线，持久提交由14，认领/归因由17；本页无开仓。
- 混合计价FX仅在12预览时取证，页面不预判。
- 指纹以真实now评估：跨15分钟或整点翻页会回到第1页并提示，这是有意的（不以旧时间让stale看似fresh）。
