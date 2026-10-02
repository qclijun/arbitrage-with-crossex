# 监控与通知自身失败时如何避免静默

Parent: ../map.md
Label: wayfinder:grilling
Type: grilling
Status: resolved
Assignee: Codex
Blocked by: none

## Question

确定持久化预警状态、发送失败重试、恢复通知、进程外心跳、敏感信息最小化与验收方式。如何在不改动运行中交易服务的情况下，验证每条规则及 Telegram 发送路径？

## Comments

- 用户已同意其余方案；重试、恢复、去重、独立服务及外部心跳检查已实现并测试。该议题保留给实际部署外部心跳的覆盖验证。

- 同一机器上的脚本不能在机器断网或关机时可靠地通过 Telegram 告警；需要进程外监视才能覆盖这类故障。
- 检查失败必须保留未发送告警，只有 Telegram 确认成功后才能更新已通知状态。
- 验收需要规则边界测试、缺失/过期/部分数据测试、恢复与失败重试测试，以及只读实盘 dry-run。
- 真正的持续通知尚未配置或启用，不得把方案和草案报告为运行成功。

## Answer

2026-10-02：用户确认沿用evaluate、notify_report并增加CLI/外部心跳测试；另确认本次仅交付脚本与离线验收。发送前持久化队列，每批Telegram确认后保存状态；模拟崩溃、失败与部分送达后重启重试，恢复仍遵守连续两轮去抖。消息隐藏钱包地址、token与chat id。

独立心跳接收端处理缺失、损坏、未来、过期及连续采集失败，新增独立主机service/timer生成器及部署验收说明；不修改交易服务。离线测试验证Telegram请求与成功/拒绝路径，没有发送真实消息。实际外部主机部署、传输中断测试及真实Telegram收件确认尚未执行，因此不宣称失联覆盖或持续通知已经启用。详见 [部署验收](../../../docs/RISK-MONITOR-CONTRACTS.md)。

验收：46项Python监控测试通过；yarn verify通过（2377项后端/单元、1278项UI）；生产web构建、Python编译、bash语法及外部service/timer静态校验通过。Standards与Spec双轴审查发现的缺失数值、结算覆盖、恢复去抖及单位问题已修复并复核。未运行实盘测试。
