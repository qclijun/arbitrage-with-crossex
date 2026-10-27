# 持久提交身份、丢响应查询与执行回显恢复

Type: task
Status: open
Assignee: none
Blocked by: 03, 04, 06, 12, 13

## Goal

使用12的服务端身份/查询协议和13入口，实现[03执行契约](../preflight-and-execution.md)的持久跟踪与恢复；不添加第二执行器或独立recovery状态。

## Scope

- 提交前可靠建立候选到意图的持久映射；刷新/跨页面恢复原deal，包括终态partial/dust，不靠内存modal、短TTL本地map或最新active项猜测。
- 双击/重试复用原身份与业务内容。超时先按原id查询，未决时阻止新单；只有原提交未被接受且迟到请求不可能再接受，才允许新预览/人工新意图，不能以一次not-found推断失败。
- 本地存储失败、服务端查询失败或身份缺失须显式提示并保守处理，不静默换id。重复回执关联原状态，不延长deadline或凭旧预览重开仓。
- 展示目标/两腿实际累计成交、残余/dust、stopped/HALTED及原样unknown/quarantine；202/DONE不得冒充全量零差，B reservation不等于B成交。
- 页面不补第二票或自动回滚；仅观察/使用既有engine控制，对冲已成交量仍走正常reconcile。04负责长期仓位归属，执行记录不自动认领旧仓。

## Acceptance

离线UI/server集成TDD覆盖丢POST响应、双击/并发、同id异内容、本地TTL到期/存储失败、迟到请求、刷新时原票已DONE有dust、多个活票、部分成交+B拒单、unknown及停止成交竞态。证明同一确认最多一个deal、不会因页面恢复新增订单或重置期限；仅fake venue/app.inject且封锁HTTP，最终yarn verify与web production build。

## Comments

- 2026-10-27：03确认后预拆，依赖04/06、12/13；不是本轮产品实现或实盘授权。
