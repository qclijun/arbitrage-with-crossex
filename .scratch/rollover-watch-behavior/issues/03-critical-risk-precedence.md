# 03: 风险告警独立于收益计算并保持 CRITICAL 优先级

**Type:** task

**Status:** ready-for-agent

**Progress:** resolved

**What to build:** 盯盘已经观测到资金费空档等 CRITICAL 风险时，即使报价或费用证据缺失、A 无法计算，或当日建议被抑制，报告首行仍准确呈现 CRITICAL；账本及报告对同一风险保持一致。

**Blocked by:** None (can start immediately).

**Confirmed reproduction:** 输入资金费空档 301 秒且费用证据缺失时，账本警告已有 CRITICAL，但首行仍是 UNKNOWN；将建议抑制与同一空档组合时，首行变成 WARN。

- [x] CRITICAL 风险判定不依赖 A、M 或其他经济性数值是否存在；缺报价或费用证据不能跳过独立风险评估。
- [x] 已知资金费空档严格大于 300 秒时，报告首行、风险说明及账本警告一致呈现 CRITICAL，不被 UNKNOWN 或建议抑制降级。
- [x] 多个状态并存时仍保留数据缺失原因、抑制原因和人工处置提示；CRITICAL 不解除 pending/unknown 交易禁止重发的约束。
- [x] 资金费空档恰好 300 秒不触发“大于 300 秒”告警；缺失空档保持 UNKNOWN，不猜测为 0 或伪造 CRITICAL。
- [x] 离线回归覆盖有完整收益、A 缺失、建议被抑制、以及 A 缺失与抑制同时存在的 301 秒空档场景，并覆盖 300 秒与缺失空档边界。
- [x] 验证仅使用合成风险证据和临时账本，不访问真实账户或发送交易。

## Comments

### Answer — 2026-10-18

独立风险判定始终运行并同步写入账本；首行 CRITICAL 优先于数据缺失及建议抑制，同时保留缺失/抑制原因和禁止重发提示。离线回归覆盖 301 秒与 A 有/无、抑制有/无的组合，以及 300 秒和缺失空档边界。

验证：`python3 -m unittest discover -s tests/monitor -p 'test_rollover_watch*.py'`，38 项通过。各行为先由新增 CLI/报告/临时账本回归复现失败，再实现至通过；仅用合成终端与时钟，不访问真实账户。等待整体双轴审查及统一提交。

最终验收（2026-10-18）：Standards 与 Spec 双轴复审均无剩余必修项；yarn verify 通过（后端3188通过/8跳过，前端1586通过），monitor143通过，screening43通过，UI生产构建通过。仅离线验证，无真实账户或交易调用。
