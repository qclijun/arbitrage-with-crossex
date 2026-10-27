# 服务端预览证据、最终准入与幂等协议

Type: task
Status: open
Assignee: none
Blocked by: 03, 04, 06, 11, 15, 16

## Goal

06准入后实现[03执行契约](../preflight-and-execution.md)的服务端权威门槛；复用唯一engine，补齐[现有缺口](../evidence/preflight-review.md)，不靠客户端按钮代替验证。

## Scope

- 定义精确候选/窗口/snapshot、最终数量/杠杆/价格/maker/timeout、成本及转换授权绑定的服务端预览凭证，最多10秒有效，不用shownAt或旧证据续命。
- 接受新意图时只读重验历史/cutoff、live规则/单位/lot/min/max、实际费用/深度/必要借款换汇、余额保证金/权限/杠杆及04确定的仓位/冲突门槛；UNKNOWN/不置信/读取失败不可fail-open。
- 消费15的切片归属/可用数量和16的Risk适用证据；同向共享必须全部相关数量可对账，不能靠客户端标签豁免或把未归属旧仓当成本策略。
- 变化或过期返回新预览重确认，不静默改量/价格/clamp。缺机会证据不能回退普通pair；既有人工入口兼容由06裁定。
- 持久化候选到意图身份、业务内容指纹及可查回执；同id同业务内容返回原deal，同id异内容拒绝。原子处理并发/过期，重复请求不重置deadline，查询覆盖终态而不只active列表。
- 把杠杆等场所变更归唯一engine，预检无副作用，route只写意图/wake，每tick最多一次wire mutation。若需持久化/迁移，按06确定的兼容与回退方案实施，不另加recovery状态。
- 保留默认300秒、30–3600秒的已授权到期CONVERTING；核验正常/转换费用证据及初次授权，不新增到期停止选项或声称IOC有硬价格保障。

## Acceptance

先用离线server/unit TDD验证10秒边界/长按末尾过期、跨整点、证据变化、UNKNOWN/NaN/费率缺失/盘口不足、反向仓和活动冲突、同id并发及异payload、迟到请求不能复活旧确认、查询终态与期限不延长。证明失败准入无venue mutation，杠杆也受单writer/一tick一变更约束；转换未授权或费用未知拒绝。仅app.inject、fake venue/clock，封锁真实HTTP；类型检查/单文件测试常跑，最终yarn verify及web production build。

## Comments

- 2026-10-27：03两轮决定后预拆，仍等待04/06及11，当前不可认领实施。
- 2026-10-27：04已resolved，增加15/16依赖；产品门槛已确定，仍等待06及实现证据。
