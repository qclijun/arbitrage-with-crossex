# 22 完整门禁暴露的用户指南竞态

2026-10-30 Asia/Taipei。首次默认 `yarn verify`：后端177文件、3614通过/8跳过；前端117文件中1785通过/1失败。失败为 `App.test.tsx:317` 用户指南编号测试，`findByRole('dialog')` 提前抓到 `New here?` 提示框，随后找不到指南正文 second。完整日志 `/tmp/issue22-verify.log`，未改变默认并发或超时。

## 诊断与修复

假设按优先级：延迟提示未重新检查已完成状态；通用 dialog 查询在指南加载期间选错；测试间状态泄漏。单独 App 文件20项通过，但它不能排除满负载下的时间竞态。既有 UserGuideHint 公共组件边界可稳定最小化：组件已挂载时由其他入口调用 `markGuideHintDone()`，分别在提示显示前和显示后进行。用 fake timers 精确推进时间，两例在原实现均失败（`/tmp/issue22-red-hint.log`）；清空 localStorage 的隔离测试同时排除必须跨文件污染才能复现的假设。

根因：`markGuideHintDone()` 仅写 localStorage，已挂载组件既不收到通知，也不取消自己的1.2秒计时器；回调无条件 `setShow(true)`。因此提前打开指南后，提示仍会稍后出现；已显示时也不会自动消失。不是指南正文内容或历史接口造成。

修复：完成函数通知当前窗口；提示组件收到后取消待触发计时器并立即隐藏，卸载时移除监听；计时器回调也检查完成状态。不把通用对话框查询改成掩盖提示仍出现的测试替身。两项回归及 App 文件共29项通过（`/tmp/issue22-green-hint.log`）；两个审查 agent 均复核通过。默认完整 verify 和 production build 重新执行，最终结果见22交接。

## 第二次完整复跑的独立瞬态失败

指南修复后，第二次默认verify的后端再次全通过；前端1787通过/1失败，失败变为 `StrategyWizard.test.tsx:465` 零成交用例未看到Retry。既有单用例随后通过（`/tmp/issue22-zero-repro.log`）。按确认中断、已请求但未渲染、调度延迟三种假设加临时按钮状态/执行时间诊断，再运行**默认整个前端套件**，117文件1788项全部通过（`/tmp/issue22-web-diagnostic.log`）；该次记录按钮未禁用，约956ms后执行请求到达。因未重现失败，尚不能把任何假设称为根因，也没有据猜测修改交易确认逻辑或放宽测试。全部临时诊断已移除，StrategyWizard文件恢复原状，默认完整verify重新执行。此瞬态失败作为已知未复现验证限制保留，不把诊断单跑或前后端分别通过拼作最终完整验收。

最终移除诊断后的默认完整 `yarn verify` 退出0：后端3614通过/8跳过，前端1788通过，耗时201.64秒（`/tmp/issue22-verify-clean.log`）。Web production build退出0（`/tmp/issue22-web-build-final.log`）。没有调整测试并发/超时；此通过不追溯转换第二轮瞬态失败为已查明根因。
