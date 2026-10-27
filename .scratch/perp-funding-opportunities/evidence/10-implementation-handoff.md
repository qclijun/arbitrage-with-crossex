# 工单10实施交接

目标：在08/09之上实现全有向候选身份与纯历史排名。用户确认接缝：只交付纯领域模块`src/core/funding/ranking.ts`（`enumerateFundingCandidates`、`rankFundingCandidates`读`FundingHistoryCache.evaluate/snapshot`），不接index.ts/AppDeps、不加路由或页面（18承接），不含成本/回本（11）。提交主题：`feat: add directed funding candidates and historical ranking (10)`。

行为：候选只由已证经济标的及相同费率口径的合约形成，跨场所全部有向组合，同场所多合约按精确合约分身份、不自配；无法成对的合约给出`identity-conflict`/`underlying-unverified`/`rate-basis-unverified`/`rate-basis-mismatch`/`no-comparable-peer`。枚举不读当前费率，候选数与方向不依赖当前max/min。排名默认30天、7天对照；按所选窗口未舍入的有符号`netTotal`（同窗口同天数，序同年化）降序，真同分按标的、short、long稳定标识升序；仅complete且fresh进入排名，UNKNOWN/stale/冷启动/缺腿排在全部排名项之后作观察并附原因（`history-cold-start`、`history-clock-behind`、`short|long:history-leg-missing`、`history-cutoff-behind`、`history-<coverage>`及逐腿原因、`short|long:history-stale`），不按零排序。每行五窗口固定同一两腿。过滤（币种、任一腿场所、只看正利差——UNKNOWN不算正）只改视图，`candidateCount`不变；先全局排序再分页，`rank`为过滤后全局名次。当前一期按各腿自身周期年化后单列，只在所选窗口已排名时提示`reversed`，报价超出一个结算周期或在未来则不对照；执行阻止原因原样分列，不影响排名/资格。`history.ts`仅导出十进制辅助并抽出`divideRounded`，结果不变。

验证：新单测11/11（`tests/unit/funding-ranking.test.ts`，夹具`tests/helpers/funding-ranking-fixture.ts`，真实缓存＋合成快照）；tsc、文件预算通过；根目录3316通过、8跳过；web build通过；`yarn verify`默认并发web段两次分别有2项（PairTicket 5秒超时、App设置）与1项（App设置找不到对话框）既有UI失败，本票未改web，单独运行2/2通过，2 workers全量1710/1710通过。日志：`/tmp/ticket10-verify*.log`、`/tmp/ticket10-web-limited2.log`、`/tmp/ticket10-web-build.log`。

已知限制与待办：`fresh`依赖`now`，同一snapshot跨15分钟或UTC整点翻页时行可能由排名转观察；18须在一次浏览中固定snapshotId与评估时间并在snapshot替换时提示重载。LiveFundingContract的标的/费率口径证据须由上游映射提供（别名归一化不算证明），当前报价来源及时效政策由18/03接线。
