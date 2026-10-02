# 四腿持仓日常检查与预警监控

Label: wayfinder:map
Status: resolved

## Destination

交付覆盖本次讨论全部八类风险的日常 checklist、只读监控脚本和 Telegram 预警。每项检查都有指标、数据来源、预警规则和应对措施；缺失数据不得显示为安全。

## Notes

- 用户明确要求脚本交付，执行纳入本地图范围；已完成配置契约与对应实现，不把规划文档当成运行成功。
- 使用 wayfinder、grilling、domain-modeling；结构探索使用 codebase-memory。按本地 Markdown tracker 保存地图及子议题。
- 无已配置 tracker，采用 local-markdown 默认规则；如需长期设置，可运行 `/setup-matt-pocock-skills`。
- 有实盘持仓：监控只读，不重启、升级或修改运行中的交易服务，不执行自动下单、减仓、充值或转账。
- 用户选择自己的 Telegram bot；现有 Pendle 托管通知连接不能发送通用 checklist 消息。敏感配置在本机隐藏输入，不能粘贴进聊天或提交 Git。
- 用户已确认：频率可配置，初始每5分钟，其余方案同意。
- 指标分为自动实测、自动派生、人工确认；人工确认也必须有时间戳、有效期及过期预警。
- 初始保证金覆盖率、维持保证金健康度、UI Health Factor 不得混为一谈。
- 数据过期、权限不足、接口错误、覆盖不全必须输出 UNKNOWN；独立于风险数值预警。
- 清单草案位于 [日常风险检查指标草案](checklist-draft.md)。

## Decisions so far

- [监控通知与运行方式如何满足用户的日常需求](issues/01-notification-operation-contract.md)：确认配置化300秒监控与专用Telegram；已交付对应脚本和向导，待用户本机配置凭据启用通知。

## Delivery and remaining operations

- 三个议题的实现与指标契约已交付；用户确认本次仅交付脚本与离线验收。
- 全部32项覆盖独立合成风险场景；缺失、错误证据与过期不显示安全；发送失败与进程中断保留未确认队列。
- 外部主机部署、心跳镜像传输、真实Telegram接收确认尚未执行，运行覆盖不能由离线测试推断。
- 事件、ADL、完整盘口与其他外部指标仍须真实有效证据；自动不核实之处保持UNKNOWN。

## Out of scope

- 自动交易、自动补仓、自动转账和自动展期；用户要求指标与通知。
- 将托管、合约或预言机风险压缩成“无风险”结论；健康检查只能反映观察到的信号。
- 把本期预期收益年化当成保证收益，或拿浮动净权益变化伪装成纯套利收益。
