# 02: 开仓复核只看所选 pair 两条腿的证据

**What to build:** Preview 不再绑定整份历史快照，而是绑定所选 pair 两条腿的证据摘要。服务端接受时只复核这两条腿：其他腿的变化不会让这个 Preview 失效。例如 BTC 回填补齐了长窗口，ETH 的 Preview 照样可以接受。前端订单表单也只在这个 pair 的证据变化时才丢弃 Preview。

**Blocked by:** 01（复用它的逐腿证据摘要）

**Status:** needs-triage（可选，由维护者决定是否实施）

背景：工单 01 之后，任何一条腿的证据变化仍会改变整份快照的 id，从而让所有 pair 的 Preview 失效。不过 Preview 本身只有 10 秒有效期，且当前只采集 ETH/BTC，两者撞上的概率很低，所以收益有限。2026-11-01 拆分时建议先不做；如果实测中经常出现 `history-snapshot-superseded`，再启用。

## Acceptance

- [ ] Preview 内容和确认哈希绑定的是 pair 证据摘要：截止点加上两条腿各自的证据摘要
- [ ] 其他腿证据变化后，接受仍然成功；这两条腿任一证据变化或截止点前进，接受被拒并返回新 Preview
- [ ] 截止点跨小时、恢复数据、不合格窗口这些既有的拒绝原因不变
- [ ] 前端只在所选 pair 的证据摘要变化时丢弃 Preview
- [ ] 旧的 `snapshotId` 请求字段有明确的处理方式：要么兼容，要么以 400 拒绝并给出原因，不能默默放行
- [ ] 服务端测试只用 `app.inject()`；`yarn verify` 和 `yarn --cwd web build` 通过；不发真实交易请求
