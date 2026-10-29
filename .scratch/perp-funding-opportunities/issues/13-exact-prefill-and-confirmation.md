# 精确两腿预填、编辑失效与风险确认

Type: task
Status: resolved
Assignee: Claude
Blocked by: 03, 05, 12, 18

## Goal

依05原型、12服务端协议实现[03执行契约](../preflight-and-execution.md)的机会到两腿票据入口；复用PairTicket/preview/ExecuteControl，不进入Boros四腿wizard。

## Scope

- 携带精确场所/合约/方向、历史窗口和快照身份，不按venue取首个symbol；规模及杠杆由用户填，maker显式选，不自动最大杠杆或缺费率替选。
- 十进制字符串保留原输入；显示实际最终数量及取整依据，不用整数美元或toPrecision格式化改变意图。只提交已确认的最终参数。
- 任何规模/杠杆/maker/价格/timeout/情景编辑取消旧预览与长按，切两腿/方向须重选历史候选。客户端10秒/800ms交互配合服务端expiry，参数/成本/警告变化必须重新确认。
- 同时展示maker＋hedge和到期未成交A转taker费用情景，明确300秒默认/30–3600秒范围，转换必须初次授权。暂时单腿暴露、IOC无硬价格/总成本上限与残余风险须明确。
- 零/负历史差或非正情景允许人工确认并突出警告；UNKNOWN/硬门槛不能靠风险勾选豁免。提交使用12的持久身份，不另建直接执行捷径。

## Acceptance

离线UI TDD覆盖同venue多合约、精度/小额/步长、maker与手动杠杆、编辑长按中止、过期/更新回执、转换授权与双费用情景、未知费率/薄盘口、负情景警告及重确认。证明身份、数量、方向不偷换，旧凭证/禁用门槛不能绕过12；不影响既有四腿/三腿入口。类型检查、针对单文件测试与最终yarn verify/web production build，不读实盘数据。

## Answer

2026-10-29用户签收。实现197f1cd＋ee426f0：A页右侧详情内`FundingOrderForm`只走12协议，精确两腿/快照/窗口与原样十进制，maker腿、两腿杠杆、数量、持有天数无默认，timeout 30–3600不夹值；任何编辑或新snapshot作废预览与确认；长按需无阻断previewId、未过期（服务端口径且不晚于请求发出时刻＋寿命）、准入开启、转换授权与风险确认；409新预览替换并清确认，网络错误/5xx结果未知不重试并阻止本页新开；回执轮询至DONE并显示两腿实际累计。默认`yarn verify`退出0、build通过。intentId持久化、丢响应查询与刷新恢复归14；不启用交易。详见[13实施交接](../evidence/13-implementation-handoff.md)。

## Comments

- 2026-10-27：03确认后预拆；等待05/06及12，不把当前预填能力冒充精确身份协议。
- 2026-10-27：06候选定稿：消费18正式A页及12协议，把11金额/费用情景、精确参数和人工确认接入右侧连续详情；不开新独立交易捷径。观察阶段保持关闭，完整启用等待21及用户明确操作。
- 2026-10-27：用户最终确认06共同理解，06已resolved并解除本票对应阻塞；其余依赖及验收要求不变，不自动认领、启用或部署。
- 2026-10-29：用户确认范围与接缝并claimed：A页右侧详情内新建`FundingOrderForm`，复用HoldToConfirmButton(800ms)，只走12协议（`/funding/preview`→`/funding/intents`），不改PairTicket/ExecuteControl及四腿/三腿入口；13只做内存回执（确认时生成intentId、202/200回执与本页轮询、409附新预览即替换并清确认、网络错误显示结果未知且禁止新建、不自动重试），intentId持久化/丢响应查询/刷新恢复归14；持有天数必填无默认；准入关闭时可预览不可提交。测试接缝：web组件`FundingOrderForm`（msw），服务端不改。
- 2026-10-29：实现197f1cd＋审查修正（本次提交）：详情内`FundingOrderForm`走12协议，编辑/新snapshot作废预览与确认，到期以服务端口径且受请求发出时刻约束，409新预览替换，网络错误/5xx结果未知不重试并阻止本页新开，回执轮询至DONE。默认`yarn verify`退出0、build通过。等待用户签收，不启用交易。详见[13实施交接](../evidence/13-implementation-handoff.md)。
- 2026-10-29：用户签收，追加Answer并resolved。
