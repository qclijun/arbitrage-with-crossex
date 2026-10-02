# 监控通知与运行方式如何满足用户的日常需求

Parent: ../map.md
Label: wayfinder:grilling
Type: grilling
Status: resolved
Assignee: Codex
Blocked by: none

## Question

选择通知接收方、检查频率和阈值风格；确定脚本以单次检查和持续只读监控两种方式运行时的期望。哪些状态立即通知，哪些只在状态变化时通知？监控自身停机如何被发现？

## Comments

- 2026-10-02 用户确认：频率必须可配置，初始每5分钟，其余方案同意。开始执行本议题与已授权脚本实现。

- 用户选择 Telegram，事实核查发现现有连接是 Pendle 托管服务，只有 liquidation/interest/maturity/rollover 四类设置，无通用消息发送接口。
- 用户随后选择“使用我自己的 Telegram bot；若未配置，提供本机配置向导”。
- 现有 `/api/telegram` 查询显示 connected=true；没有泄露凭据，没有发送测试消息，没有修改服务。
- 等待检查频率问题回答：建议每 5 分钟、偏保守阈值。必须明确建议不是用户已确认的决定。
- 拟采用状态变化通知、严重度升级通知、可配置持续提醒、恢复通知及发送失败重试；具体契约待本议题解决。
- Telegram 配置向导拟分为：创建/选用 bot 并隐藏输入 token；用户与 bot 建立私聊并确定 chat id；保存专用、Git 忽略、权限受限的本机配置；验证接收方后发送测试通知。

## Answer

用户确认配置化频率、初始300秒，并同意其余方案。交付只读Python监控、32项规则、专用Telegram本机向导和独立用户服务生成器。WARNING/UNKNOWN默认连续两轮、CRITICAL即时、状态变化/恢复通知、6小时持续提醒、发送失败保留队列重试、3%数值解除迟滞。监控自身失联须由外部主机检查镜像心跳，不能由本机自证。

资产/指标覆盖采用已获用户同意的UNKNOWN与带时效外部证据方案。官方Boros净余额、可用维持保证金、gas已直接只读验证；没有凭据不得冒称Telegram已启用。

交付链接：[检查清单](../../../docs/DAILY-RISK-CHECKLIST.zh-CN.md)、[监控脚本](../../../scripts/risk_monitor.py)、[本机配置向导](../../../scripts/setup-risk-monitor.sh)。22个合成场景测试通过；一次实盘只读检查32项，18项OK、14项UNKNOWN、接口无错误。没有下单、转账、重启交易服务或发送Telegram消息。
