# 数据推算周期交接

2026-10-31用户明确变更约定：不需要严格历史规则证据，优先从资金费率数据推算。目标是让已有真实结算数据取得可解释的覆盖状态和排名；当前约定已同步到[历史契约](../history-and-eligibility.md)、规格及08工单，旧补证方案不再是生产排名的硬前提。

生产采集已默认启用推算。连续三个相同间隔确认周期，持续变化形成分段，孤立较大间隔继续检查缺期。整点后999毫秒以内的时间偏差允许推算归一，保留原始时间及映射标记；包括窗口起止点的回归已覆盖。缺失上市信息时推算首个周期的存在边界，已有精确上市时间保留。周期估计更新不伪装成费率修订，原始费率冲突仍隔离。页面显示inferred、周期和样本；开仓开关独立保留。

真实公开复核：30次请求，三家BTC五窗口15/15通过，均推算8小时，全年各1095期。隔离页面排名与正收益过滤通过，手机390像素无整页溢出。最终verify退出0，后端3709通过/8跳过、前端1792通过，生产构建通过。正式六方向均排名，五窗口30/30合格，开仓关闭。原配置和数据保留，未发送交易请求。此记录随修复提交；HL跨基准候选纳入仍由独立工单跟进。

## 证据

以下原始快照、临时脚本和日志由 `.gitignore` 过滤，仅保留在验证机器；仓库保留此验收摘要及离线回归测试。

- 公开复核：`2026-10-31-inferred-cadence-public-year.json`、`2026-10-31-inferred-cadence-public.ts`。只含公共历史，无账户快照。
- 回归：`/tmp/funding-inference-red.log`、`/tmp/funding-inference-jitter-red.log`、`/tmp/funding-inference-final-focused.log`、`/tmp/funding-inference-refresh.log`。
- 全量检查：`/tmp/funding-inference-verify-final.log`后端通过但编排退出1；按RTK指引原始复跑`/tmp/funding-inference-verify-raw.log`最终退出0，所有检查通过。构建：`/tmp/funding-inference-build.log`。
- 正式复核：`2026-10-31-inferred-cadence-production.json`，健康200、无token401、开仓关闭；服务绑定127.0.0.1:6688，沿用原配置与数据。
- 隔离浏览器：`2026-10-31-inferred-cadence-browser.ts`、`/tmp/funding-inference-desktop.png`、`/tmp/funding-inference-mobile.png`。合成历史、生产构建、真实app.inject、禁止写请求及外部网络；不作为真实收益证据。
- 实现：`cadence-inference.ts`负责推算；`history-merge.ts`负责保留旧快照及费率修订；collector生产开关启用，API和页面传递来源。严格纯校验器仍可用于离线比较。
- 数据推算无法完全区分系统性漏记与持续周期变化；页面与元数据保留推算来源，不声称获得独立文档证明。
