# 21初测失败与最终结果分层

本轮没有改生产执行/准入逻辑，也没有调并发、放宽断言或延长产品期限。下列是新验收夹具/驱动的错误假设和故障注入差异，不能称为已发现并修复的生产缺陷。默认完整verify最终一次执行通过，历史App/StrategyWizard偶发本轮未复现，不宣称根因已修复。

## 服务端夹具

- 首条断言误以为准入关闭的只读preview必须HTTP403，实际合同是HTTP200+admission-closed blocker；改为验证blocker及接受前零场所调用。没有把关闭入口放宽。
- maker在第2tick尚未完成逐腿杠杆检查，读取liveOrder得到undefined；按既有一wire/tick协议先核杠杆，第3tick才观察maker，并实际检查unknown-delivered后的PENDING。
- 明确Stop且cancel已确认时，既有引擎可取证后force-resolve陌生状态；原测试却要求仍quarantine。改用fake venue的cancelsFail构造真正未确认取消，验证其冻结、后续已知状态与真实0.05成交恢复；没有改引擎。
- app.close不负责关闭调用者注入的Store，恢复演练先收到ledger-in-use。修正夹具明确关闭其持有Store后，分别验证ledger-has-new-writes和无新写入时安全恢复；临时库均回收，未操作运行账本。

早期服务端定向日志在后续同路径绿跑时被覆盖；以上错误片段及更正是本轮工具结果转录，不冒称仍保留原始失败文件。最终可复现的测试源码、成功日志与下述独立浏览器失败记录保留。

## 浏览器夹具/驱动

- 导航刚开始时document.body为空；DOM条件改为判存在。CDP returnByValue不能序列化整DOM节点，条件返回Boolean。两者均是驱动问题。
- 正利差筛选实际显示“1 of 2 pairs”（全局全集分母），不是“1 of 1”；按现有排序/过滤合同修正断言。
- App消费一次性?tab参数，刷新默认回Opportunities。驱动如用户一样刷新后重新选Funding Spreads，并仅对可见、已聚焦控件输入，未改产品导航。
- 初始引擎/浏览器使用虚拟10月1日，但API envelope仍是系统时间，导致防御性期限立即过期。修正独立fixture进程的Date.now与浏览器为同一虚拟时基，仍按真实耗时推进；不延长10s或覆盖历史publishedAt。
- 早期在响应头前直接RST，服务端看见同id的202后200，仍仅一个deal。当时没有JS fetch观测，未独立确认重试层级，不把它判为应用层重发。最终改成已发状态头后截断正文并加JS边界记录：每个重新确认的intent只有一次fetch，接受后只GET恢复，始终一个deal。
- 首次Positions只拍到无钱包资产空态，未据此证明数量界面。补实际打开Strategy ownership，检查两腿各0.05、reconciled和费用/收益UNKNOWN；Risk保留外部证据UNKNOWN，三腿/四腿各实际打开对应向导。
- 人工QA发现滚动中全页截图使sticky header落在中间且tooltip覆盖控件；驱动截图前回顶部、移开鼠标并在独立profile关闭提示。没有改页面布局或生产样式。

较早原始驱动结果在`21-browser-runs/initial-discovery`及各失败时间目录，另有`/tmp/issue21-browser-attempt{1,2}*`诊断资料。所有时间目录保留result与截图，不以早期失败图充当完成证明。最后通过的14步目录为`21-browser-runs/2026-10-30T00-14-55-853Z/`，详见[浏览器验收](21-browser-acceptance.md)。

## 接续认证补强

新增负例先在未修补夹具复现：无token的`/api/credentials`返回200而非401（退出1，日志`21-validation-logs/browser-auth-red.log`，失败元数据已并入归档）。随后仅在隔离bridge的/api分支统一校验TEST_TOKEN；缺失/错误token访问credentials、account、funding/opportunities共6项全部401。完整14步浏览器重新通过，strict typecheck通过；生产与已验证测试源码hash不变，故保留原完整gate，不重复挑绿。新运行关键截图已人工复核。

## Standards审查修复

审查发现合成position_value使用Number浮点，违反项目decimal约定；本次0.05×2500恰为125，未发现已有页面结果错误。改为既有fx/fxStr与bigint精确计算，未改生产源码。修后strict类型检查、6项认证负例和完整14步Chrome全部通过，最终1个deal、2次create、准入关闭。修前绿色捕获及日志保留在历史提交，未删除本机中间档案；最终目录以上文与21-validation.json为准，已复核新Positions/部分成交截图。
