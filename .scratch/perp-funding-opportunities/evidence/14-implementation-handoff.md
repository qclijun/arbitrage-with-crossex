# 工单14实施交接

目标：[03执行契约](../preflight-and-execution.md)「提交、幂等与恢复」：持久提交身份、丢响应按原id查询、刷新/跨页恢复原deal及真实成交回显。用户确认接缝（2026-10-29）：①提交前localStorage记录写入/读回失败即拒绝提交并明示；②迟到请求不可接受的证明由服务端按预览给出；③新增按候选只读列出账本已接受意图，无本地记录时查看，不认领、不作新单依据。测试接缝同12/13：服务端路由`app.inject`，web `FundingOrderForm`/`FundingOpportunitiesPanel`（msw）。

## 交付

- **查询证明**（`GET /api/funding/intents/:id?previewId=`）：找到→回执；未找到且带previewId→`lateAcceptance`：仅当服务端时钟≥该预览expiresAt、预览已被其他意图消费、或本进程不识别该预览（重启/遗忘）时`possible:false`，否则`possible:true, until`。依据：接受只在重读后`now<expiresAt`时同步写入，此后同预览不可能再被接受。不带previewId的404不给结论。类型`LateAcceptance`在`previews.ts`，web直接复用。
- **按候选列表**（`GET /api/funding/intents?candidateId=`）：账本该组合全部已接受意图（含DONE），新到旧，只读。
- **回执扩展**（`receipt()`）：`aReserved/bReserved`（在途，不是成交）、`aUnfilled`=目标−maker实成（下限0）、`filledGap`=maker实成−hedge实成，以及逐单`clientId/leg/kind/side/qty/cumQty/state/closeReason/quarantinedStatus/venueReason`原样。
- **本地持久记录**（`web/src/panels/funding/submissions.ts`）：每意图一个键`crossex.fundingSubmission.v1.<intentId>`，存完整接受体＋候选＋时间，无TTL；写后读回一致才算记录；任一键不可解析即报“不可读”且不覆盖。每意图独立键避免多标签页读改写互相覆盖。
- **页面提交状态**（`FundingSubmissions.tsx`，面板级Provider）：载入全部记录并按id查询（未决1秒、运行中2秒轮询，DONE停）；`never`才释放并提示；裸404、`possible:true`、查询失败均保持未决并阻止本页任何新开。发送前重新读取存储：存在本页未知结果的他页记录即拒绝发送。存储被清/记录消失而仍未决时继续查询并写回，写回失败明示。删除记录失败时本页内仍释放并明示“重载会再次查询”。监听`storage`事件跨标签页同步。
- **表单**（`useFundingOrder`）：确认→记录（失败显示“Not sent: …”，不发送）→单次POST（15秒无应答视为丢响应，`Promise.race`，不中止也不重发）→2xx写回执；网络/5xx/超时→交给查询；4xx视为服务端在写入前的明确拒绝并释放，`intent-conflict`除外（id已在账本→查询）。`sending` ref防双击重复发送。服务端路由注明写入后不得再返回4xx。
- **展示**（`FundingReceiptView.tsx`）：模式、目标、两腿实成、maker未成、已成未对冲、在途（不是成交）、deadline、halt/报告、订单表（隔离状态原样标红、拒单原因）；DONE有缺口提示残余/dust、未达目标提示；STOPPING/HALTED注明成交仍可能变化；“Open the deal view”打开既有DealModal（既有Stop等控制）；仅DONE可Dismiss（只删本地记录）。面板顶部“Sent intents”列出全部已发意图；详情下列出账本中本浏览器无记录的该组合意图。13的`blocked/accepted/onAccepted/onUnknown`属性及内存回执移除。

## 审查

双轴审查。标准轴无硬违背；已改：`aUnfilled`下限0、`LateAcceptance`共享类型替代鸭子类型、回执摘要去重（`dealSummary`）、`FINAL`→`FINAL_MODES`、`Api/key`改名、`refused`去除无用字符串、存储键加版本。规格轴：存储被清时未决意图静默消失、多标签页整表读改写覆盖、`intent-conflict`被当拒绝释放、`record()`未复查他页记录、删除失败无提示——均先写测试再修复，并逐项变异确认各被一条测试捕获。自查另修：删除失败时“never”释放循环。未改（判断项）：`candidateLabel`解析候选id显示两腿（无行数据时）；`SubmissionCard`与接收视图同文件。

## 验证

新测试：`tests/server/funding-intent-lookup.test.ts`（5）、`funding-intent-receipts.test.ts`（3）；web `FundingSubmissions.test.tsx`（8）、`FundingSubmissions.restore.test.tsx`（9）、面板新增多票恢复（1）；13的表单/面板测试按新契约改写（丢响应→按id查询、重载显示回执、他页未决阻塞）。覆盖丢POST响应、双击、同id异内容（409 intent-conflict→查询）、无TTL旧记录、存储写入/读取/删除失败、存储被清、他页未通知记录、迟到请求（pending→receipt / pending→never）、刷新时DONE有dust、多活票、部分成交+B拒单、未知状态隔离、停止中成交竞态、超时、账本列表。关键守卫变异检查（裸404当失败、读回不校验、conflict释放、不写回、不复查、删除失败不提示）均被捕获。

默认`yarn verify`：审查修复后第一次web 1/1779 `App.setupOnce`“opens settings once”既有偶发失败（`/tmp/ticket14-verify2-fail.log`，本票未改，主机负载≈22）；随后第二次默认完整运行**退出0**：root 168文件3542通过/8跳过，web 116文件1779/1779（`/tmp/ticket14-verify3.log`）。`yarn --cwd web build`退出0（`/tmp/ticket14-web-build2.log`）。

## 限制

- “never”依赖服务端时钟单调前进（接受与查询同用engine时钟）；时钟回拨可能让迟到请求在“never”之后落地。单进程假设：多实例由SQLite EXCLUSIVE锁排除。
- localStorage无跨标签页锁：发送前复查缩小但不消除两页同时发送的窗口；服务端同合约活动deal冲突仍保证至多一个deal。
- 无本地记录时只读列出账本意图，不能证明某个丢失的在途请求不存在；此时新开仍由服务端冲突门约束。
- 未做真实浏览器复查（归21）；不启用交易、不部署。
