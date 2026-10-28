# 持久准入开关、旧入口兼容与在途隔离

Type: task
Status: resolved
Assignee: Claude
Blocked by: 03, 04, 20

## Goal

实现06-Q1/Q3/Q5的服务端准入边界，先支持安全只读交付，再供12权威接受新意图；不是停止整个服务或全量Stop。

## Scope

- 唯一engine持久处理开关/控制意图，首次或配置/版本状态不明时关闭；显式启用绑定已验收版本与状态。routes仍只写意图/命令并wake，不新增状态写者或wire mutation。
- 关闭后拒绝新的开/加仓，使未接受旧预览失效；开关与接受新意图并发须原子裁定，关闭后迟到请求不能被接受。重新开启不复活旧凭证；12消费同一权威状态/代次及原子检查，不重复实现第二个接受协议。
- 同id已接受请求只返回原回执/查询，不重发、不变参数；原意图查询、对账、正常probe/hedge及经验证的减风险继续。减风险必须有真实证据，不只信客户端reduceOnly标签，不强加历史排名资格。
- 已接受执行按原确认继续maker及已授权到期转taker，关入口不自动改成Stop或停loop。用户另行逐单Stop才停止该票新增A，仍遵守unknown冻结、cancel/probe/hedge及真实partial/dust回显。
- 保留四腿/三腿原策略用途；给相关人工新开入口明确来源/策略语义及协议兼容行为。普通pair缺新上下文、来源不明或不能证明归属/冲突门槛时，明确拒绝相关新增风险；不能自动降级、隐式认作浮动两腿或取得Boros豁免。机会来源必须走12完整历史/当前证据门槛。
- 正常恢复不因功能开关丢失旧执行；不认识的新旧请求明确报错，不默补数量/策略/费用。未完成15/16等证据时失败关闭，不用“旧入口兼容”提前开放新策略。

## Acceptance

离线fake clock/venue及app.inject验证：首次/重启/配置不明关闭，开启/关闭并发，关闭后迟到请求，重开旧预览仍无效；同id已接受回执仍可查询，缺字段/伪造来源/旧协议不降级；真实减风险及在途部分成交/unknown/转换不被误停。至少覆盖四腿/三腿合法用途、共享合约未知归属、非机会请求不强加历史、reduceOnly标签不自证。证明闭入口不等同stop.sh或全票Stop；一tick一wire边界不变。默认verify/build通过；与18、12及21分别验证只读交付与完整人工启用，不实际启用或部署。

## Answer

2026-10-28用户签收。实现3f2e042＋3b61853：账本步骤2加`pair.purpose/purpose_context`及`admission_switch`；`AdmissionSwitch`默认/无记录/构建（版本＋安装提交）或账本版本变化即关，每次开关递增代次，`admit(generation, write)`同事务核对开且代次一致，关后迟到与重开后旧代次均拒；`GET/POST /api/admission`只写开关，不停deal/loop、不调venue。POST /deals先按purpose分流：全reduceOnly为`reduce`（实时持仓校验不变），开仓缺purpose为`client-outdated`，`boros-strategy`须Boros上下文（base＋venues必填，其余有则校验）并保持原行为、无特权，`manual`仅在合约无持仓/活动deal/挂单时于设杠杆前放行（新鲜读取，不可读即拒，写入前同步复查），`funding-two-leg`恒不经/deals。web各票据声明purpose，仅在策略预填解析出的精确腿上声明`boros-strategy`。已知：伪造`boros-strategy`的API请求可跳过独立冲突门（用户选择不核实Boros仓，只得原行为）；默认verify web两项既有偶发超时归21。详见[19实施交接](../evidence/19-implementation-handoff.md)。12须经`admit`接受意图，不启用交易。

## Comments

- 2026-10-27：06-Q1/Q3/Q5用户已确认，现有逐deal控制不能替代本票。仍由06阻塞；20先提供可验证的持久兼容基础。
- 2026-10-27：用户最终确认06共同理解，06已resolved并解除本票对应阻塞；其余依赖及验收要求不变，不自动认领、启用或部署。
- 2026-10-28：用户确认接缝（开关范围/代次、独立票无冲突才开、四腿标签＋上下文、旧客户端开仓拒绝），claimed并实施；双轴审查后修正策略上下文随换腿残留及读取fail-open。
- 2026-10-28：用户签收，追加Answer并resolved。
