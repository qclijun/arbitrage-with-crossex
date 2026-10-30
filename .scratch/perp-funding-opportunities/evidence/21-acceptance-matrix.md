# 21最终验收矩阵

验收代码基线`9728a45`，本轮生产`src/`与`web/src/`无差异；新增组合测试/fixture及浏览器驱动随本票提交。下列实现提交是各边界当前来源，完整tree以基线及本票提交为准。行结果限定为**隔离技术验证**，现场能力UNKNOWN单列保留，不因fixture通过变为可交易。

命令与退出码、完整日志及SHA-256见[验证记录](21-validation.json)：**V0**=`yarn verify`退出0（179后端文件3631通过/8跳过；117前端文件1788通过）；**B0**=Web build退出0；**M0**=monitor151通过；**S0**=screening73通过；**BR0**=真实Chrome14步通过。8个既有skip来自Darwin限定安装/卸载suite，在Linux不冒充已运行；本票6个新增服务端用例全部执行。

路径缩写：U=`tests/unit/`，S=`tests/server/`，W=`web/src/`，P=`tests/monitor/`；以下均为实际文件，不是未来用例名称。每行至少V0，所列脚本按M0/S0另行运行。

| ID / 场景 | 实现提交 | 本轮复验的测试与证据 | 结果 |
|---|---|---|---|
| 01 周期/变化、去重冲突、窗口、新币 | 8df73e1 / 67c1a83 / a91f2c6 | U/funding-history.test.ts、funding-official-history.test.ts、funding-official-public.test.ts；[23官方/样本分层](23-documented-calibration.md)；V0 | 边界PASS；历史规则/现场限流未证部分UNKNOWN |
| 02 冷启动、半成/失败、15min/UTC整点 | 67c1a83 | U/funding-history-{cache,collector}.test.ts；S/funding-opportunities-evidence.test.ts；新增funding-integrated-readiness过期/整点；BR0 stale；V0 | PASS，旧发布时间不刷新 |
| 03 所有方向/同场所多合约、零负/同分、分页 | ad58fb0 / 67c1a83 | U/funding-ranking.test.ts；S/funding-opportunities.test.ts；BR0正负/1-of-2过滤；V0 | PASS，不因执行限制删观察候选 |
| 04 费用/VIP、深度/FX缺失、正常/转换/退出、D/C边界 | 73d48ea / e346a17 | U/funding-cost-evidence.test.ts、funding-scenario.test.ts；S/funding-preview.test.ts；W/panels/funding/FundingOrderForm.test.tsx；BR0两种费用；V0 | PASS，UNKNOWN非0，情景非成本上限 |
| 05 当前证据重读、10s/源时间/cutoff | e346a17 / 67c1a83 | S/funding-preview.test.ts、funding-accept.test.ts；新增integrated-readiness的6s重读跨10s与整点；V0 | PASS，过期404带不可迟到接受证明 |
| 06 编辑/变价/警告、800ms、零负/转换授权 | e346a17 | W/panels/funding/FundingOrderForm.test.tsx；BR0编辑、短按零发送、409新预览且确认框重置；V0 | PASS，必须再次明确确认 |
| 07 同id/异业务、丢响应、迟到、刷新/partial/dust | e346a17 | S/funding-intent-{races,lookup,receipts}.test.ts；W/panels/funding/FundingSubmissions.restore.test.tsx、FundingOrderForm.outcomes.test.tsx；BR0截断后查询/刷新；V0 | PASS，最终一个deal，不页面补单 |
| 08 默认/版本不明、关门竞态、重开/旧入口 | 3b61853 / e346a17 | U/admission-switch.test.ts；S/admission.test.ts、funding-intent-races.test.ts、funding-opportunities-evidence.test.ts；新增两条组合；BR0；V0 | PASS，200只读blocker不是接受权限 |
| 09 已接受转换、unknown/quarantine、Stop/reduceOnly | 53fdee2 / 3b61853 | S/admission.test.ts、slices.test.ts；新增integrated-readiness的未知取消冻结/恢复与原期限转换、逐tick≤1次wire；BR0实际Stop；V0 | PASS，不全量Stop、不延长原deadline |
| 10 实际量/B预留、指定减仓、共享合约/外部差异 | 53fdee2 | U/slice-{booking,reconcile,engine}.test.ts；S/slices.test.ts；新增HTTP→部分成交→slice0.05组合；V0 | PASS，不跨切片/FIFO猜量 |
| 11 4.03中0.36/3.67、混合策略/Spread、HYPE、consumer历史 | 53fdee2 / c63511d | U/slice-reconcile.test.ts、risk-producer.test.ts；W/lib/fundingApplicability.test.ts、panels/assets/assetSplit.test.ts；P/test_funding_applicability.py；V0/M0 | PASS，仅证明量豁免；旧/未知证据不重置连续历史 |
| 12 当前认领/as-of、Boros必要证据、费用/时间归因 | 53fdee2 | U/slice-{claims,claim-persistence}.test.ts；S/slice-claims.test.ts；W/panels/assets/StrategyOwnership.test.tsx；BR0 ownership0.05/收益UNKNOWN；V0 | PASS，不倒填过去；当前证据不足拒绝认领 |
| 13 一致备份、schema/索引/FK、失败/中断、旧程序 | 53fdee2 | U/ledger-{version,restore}.test.ts、engine-store-migration.test.ts；S/installer-ledger-rollback.test.ts；新增funding-ledger-lifecycle两条；V0 | Linux PASS；PS运行时未验，不冒充跨OS |
| 14 正式A页/Positions/Risk与原三腿四腿入口 | 67c1a83 / e346a17 | [BR0全部14步及图](21-browser-acceptance.md)，包括归属/UNKNOWN、两个原向导实际打开；V0/B0 | PASS；钱包签名/Boros实盘未测 |

## 对依赖签收的处理

复用07—20/22/23已签收的单票契约与最小回归，但本轮重新跑完整gate与Python；新增6条真实组合和正式构建浏览器证据，不继承旧gate为本次PASS。每个HTTP请求经app.inject，真实网络阻断；fake venue上的订单与累计成交是实际被执行的测试边界，不用attestation日志代替它们。

观察阶段和完整人工能力阶段的技术证据已分别具备，人工签收/实际启用仍待用户；见[支持范围及停用回退](21-rollout-runbook.md)。本票交付后只能报告“可申请人工启用”，不自动部署、重启、开启或交易。23的真实限流、缺头、共享IP/跨实例/重启限制，以及生产历史/经济单位不足，均继续保留在21及交接，不以UNKNOWN冒充生产能力PASS。
