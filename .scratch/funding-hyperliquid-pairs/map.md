# HL候选修复工作地图

2026-10-31：用户已确认拆分，按[规格](spec.md)发布本地工单。发布状态与实现进度分别记录。

| 工单 | 分诊状态 | 实现进度 | Blocked by |
|---|---|---|---|
| [01：恢复HL BTC/ETH跨场所方向排名](issues/01-hl-directed-pair-rankings.md) | ready-for-agent | resolved | None |
| [02：预算内刷新与过期原因](issues/02-hl-history-freshness-and-backfill.md) | ready-for-agent | resolved | None |

01、02均已完成并通过验收；当前无开放实施工单。

01结论：HL原生BTC/ETH已纳入费率差估算排名，保留服务端执行阻止。见[工单01](issues/01-hl-directed-pair-rankings.md)及[验收记录](validation-01.md)。

02结论：HL近期公平刷新、跨轮续读与逐窗过期原因已完成，旧证据时间及预算保持有效。见[工单02](issues/02-hl-history-freshness-and-backfill.md)及[验收记录](validation-02.md)。
