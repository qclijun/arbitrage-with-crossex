# 持久提交身份、丢响应查询与执行回显恢复

Type: task
Status: resolved
Assignee: Claude
Blocked by: 03, 04, 12, 13, 20

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

## Answer

2026-10-29用户签收。实现e346a17，交接a76b9bf：提交前持久记录并读回验证；丢响应按原id查询，仅服务端证明迟到不可接受才释放；刷新、跨页及多票恢复真实回执，保留partial/dust、unknown和停止竞态。离线测试及默认完整`yarn verify`、web production build通过，详细证据见[14实施交接](../evidence/14-implementation-handoff.md)。不启用或部署交易。

## Comments

- 2026-10-29：用户签收，追加Answer并resolved。
- 2026-10-27：03确认后预拆，依赖04/06、12/13；不是本轮产品实现或实盘授权。
- 2026-10-27：06-Q4/Q5已确认：持久身份遵守20迁移保全；关闭入口后已接受意图仍查询/恢复原执行，继续原maker及到期转换，不自动全票Stop。同id重试只返回原执行；未接受的迟到请求受19/12关闭代次约束。
- 2026-10-27：用户最终确认06共同理解，06已resolved并解除本票对应阻塞；其余依赖及验收要求不变，不自动认领、启用或部署。
- 2026-10-29：Claude claimed。用户确认接缝：①提交前localStorage持久记录写入/读回失败即拒绝提交并明示；②迟到请求的不可接受证明由服务端按预览到期给出（`GET /funding/intents/:id?previewId=`，服务端时钟≥expiresAt或本进程不识别该预览才settled）；③新增按候选只读列出已接受意图，供无本地记录时查看，不认领、不作新单依据。
- 2026-10-29：实施完成待签收，见[14实施交接](../evidence/14-implementation-handoff.md)；默认verify第二次全绿、build通过，人工开仓仍关闭。
