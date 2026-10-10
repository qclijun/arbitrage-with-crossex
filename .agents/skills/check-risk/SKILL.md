---
name: check-risk
description: 只读检查 arbitrage-with-crossex 项目的当前持仓风险指标，并输出中文总结报告；用于检查持仓风险、保证金、对冲和监控状态。
---

# 持仓风险检查

使用项目脚本读取终端的共享 Risk 判定，输出带快照时间、关键指标及证据缺口的中文总结。默认一次查询；使用现有账号和配置。

## 执行

从本项目根目录运行：

```bash
python3 scripts/risk_report.py
```

需要逐项核对证据或结构化结果时：

```bash
python3 scripts/risk_report.py --json
```

项目根目录是本 SKILL.md 向上四级的目录（含 package.json 与 scripts/risk_report.py）。脚本默认读取 data/risk-monitor/config.json，可用 --config 指定与终端配置一致的文件。

脚本复用 Collector.collect_report，认证请求 GET /api/risk/report?fresh=1，并读取既有 state.json 提交此前严重状态与恢复证据。只在内存处理结果：不取得监控锁、不改写状态/心跳/队列、不发送通知。不要用 risk_monitor.py 的命令行模式代替，它会取得锁并保存状态。

本机请求若被默认沙箱以 EPERM/Operation not permitted 拒绝，按当前工具权限流程在允许本机访问的环境重跑同一命令。终端不可达时报告 UNKNOWN；本 skill 不自动启动、重启终端或调整配置。

## 总结

以脚本结果为准，给出：

- 总体判定、台北时间的快照、CRITICAL/WARNING/UNKNOWN/OK/PAUSED 数量、覆盖是否完整。
- 优先报告严重、警告和 UNKNOWN 的原因及共享模型的应对建议，再列关键保证金、借款、对冲、估值、到期指标。
- 服务、独立监控和通知状态。Telegram OK 只表示历史确认送达及最新采集证据有效，不声称当前通道已完成发送测试。
- 暂停项的原因；PAUSED 不算通过。缺失、过期、部分覆盖或无法验证的值保留 UNKNOWN，不替换为零。

脚本退出码：0 为当前判定正常；2 为存在风险、UNKNOWN 或覆盖缺口，仍须读取输出；1 为查询或配置失败，不能据此判断持仓安全。失败时不使用旧报告冒充当前快照。JSON 已去除账户/钱包身份与原始 collection；不要额外打印 API token、配置凭据或完整响应。

按实际触发的阈值解释结果，不把初始保证金预警线当作交易所强平线。避免仅凭单腿浮亏或杠杆倍数判定整个对冲组合的风险。

范围是查询和报告；交易、转账、授权、测试通知及服务操作需要用户另行提出。
