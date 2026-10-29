# 工单13实施交接

目标：A页右侧详情内把选中的精确两腿接到12的预览/接受协议，实现[03执行契约](../preflight-and-execution.md)的预填、编辑失效与风险确认。用户确认（2026-10-29）：详情内新建`FundingOrderForm`，复用HoldToConfirmButton（800ms），只走`/funding/preview`→`/funding/intents`，不改PairTicket/ExecuteControl及四腿/三腿入口；13只做内存回执，intentId持久化/丢响应查询/刷新恢复归14；持有天数必填无默认；准入关闭时可预览不可提交。测试接缝：web组件`FundingOrderForm`（msw），服务端协议不改。

## 交付

- `panels/funding/orderDraft.ts`：草稿原样保存字符串；数量与持有天数须为正十进制（≤12位小数，无指数/逗号/负号），两腿杠杆为1起整数，maker价留空即同侧最优，timeout为30–3600整数（默认300，与服务端同一`server/funding/timeouts.ts`），越界即错误、不夹值；maker腿无默认。请求精确取行的两腿venue/contractId/symbol、snapshotId与窗口。
- `useFundingOrder.ts`：draft→previewing→preview→sending→accepted/unknown。任何编辑或新snapshot丢弃预览与两项确认（草稿保留），旧请求的迟到预览丢弃。到期时间取服务端口径且不晚于“请求发出时刻＋预览寿命”（409附带的新预览无服务端时间亦受此界），确认瞬间再核一次期限。接受时以`lib/uuid`生成intentId；202/200→回执；4xx附合法形状的新预览→替换并清确认、显示原因；4xx无预览→回草稿显示原因；网络错误/5xx→“结果未知”，不重试、锁定本表单并上报面板。
- `FundingOrderForm.tsx`＋`PreviewSummary.tsx`：输入、maker腿单选、预览按钮；预览区显示原始与最终数量及取整依据、两腿symbol/方向/角色/杠杆/费率、maker价与等待秒数、FX/借款、正常与到期转taker两套一次性成本/持有结果/回本（UNKNOWN不显示为数）、阻断原因、全部风险警告（含杠杆变化）；零/负历史差或非正情景醒目警告但仍可确认。长按需：无阻断的previewId、未过期、准入开启、无未知结果、勾选到期转taker授权与风险。
- `FundingReceiptView.tsx`：回执按id每2秒轮询直到DONE（HALTED仍会撤单、成交可能变化，不停止），显示模式、目标、两腿实际累计、未对冲、deadline、halt原因与报告，注明已接受≠成交、DONE≠满量。
- 面板：`unknownIntent`阻止本页任何新开；按pair保存本页接受回执，返回该pair显示回执而非新草稿（刷新后由14恢复）；准入关闭提示改为“仅可观察预览”。
- `api/client.ts`：`ApiError.details`保留拒绝信封的其他字段（12的409新预览）；`api/fundingIntents.ts`直接复用服务端`PreviewRequest`/`AcceptBody`/回执类型。

## 审查

双轴审查。规格轴（先红后绿）：回执在HALTED停止轮询会低报成交；409新预览缺服务端时间时按读取起点满算10秒，可能显示仍有效而服务端已过期（改为以请求发出时刻为界）；直接`crypto.randomUUID`在非安全来源下长按无反应（改用`lib/uuid`）；切换行丢失回执；补5xx视为未知、409无预览、200 duplicate、薄盘口/金额UNKNOWN、HALTED轮询测试。标准轴：历史净值符号改按十进制字符串判断（`decimalSign`）、陈旧注释与架构文档更新、请求/接受类型及timeout常量与服务端共用、`Side`类型复用、409预览形状校验、命名（`order`/`frozen`/`setField`/`paybackText`/`request`）。未改（判断项）：`micro`样式常量沿用既有面板写法；`admissionOpen/blocked/onUnknown`经CandidateDetail下传保持显式。

## 验证

测试：`web/src/panels/funding/FundingOrderForm.test.tsx`（15）、`FundingOrderForm.outcomes.test.tsx`（8）、面板测试新增行切换/跨pair未知阻断（共9）；共享夹具`web/src/test/fundingOrderForm.tsx`、`fundingPreview.ts`。关键行为另做变异检查（编辑/新预览清确认、网络错误当拒绝、过期可长按、准入关闭可长按均被测试捕获）。覆盖同venue兄弟合约、精度/小额、maker与手动杠杆、编辑中止长按、服务端时钟过期与确认瞬间过期、409新预览替换、转换授权与双情景、未知费率/薄盘口、非正警告、准入关闭、结果未知不重试。

默认`yarn verify`：第一次（审查前）web 1/1753 `App.setupOnce`既有偶发失败（`/tmp/ticket13-verify.log`）；审查修复后第一次web 1/1761 `StrategyWizard`“the modal cannot be closed while a Boros execution is in flight”失败（`/tmp/ticket13-verify2.log`，本票未改该组件，单跑3次18/18通过，仅诊断）；随后第二次默认完整运行**退出0**：root 166文件3534通过/8跳过，web 114文件1761/1761（`/tmp/ticket13-verify3.log`，主机负载≈25）。`yarn --cwd web build`退出0。

## 限制

- intentId与回执仅在内存：刷新页面后未知结果与回执丢失，同pair再开由服务端活动deal冲突拒绝；持久身份、丢响应查询与恢复归14。
- 未做浏览器实页交互截图（需真实交互与预览端口stub）；jsdom/msw覆盖交互，正式A页完整交互的浏览器复查归21。
- 交易权限、FX、借款、保证金均由12在预览时取证；本表单不预判。
