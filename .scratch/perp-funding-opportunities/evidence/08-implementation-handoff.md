# 工单08实施交接

目标：当前分支实现历史结算证据、五窗口覆盖与新鲜度、固定方向净费率及资格的离线纯计算，并限制官方来源归一化。提交主题：`feat: add settled funding history eligibility (08)`。

验证：新单测 11/11、根目录 3289/3289、Web 构建、类型检查及文件大小守卫通过。Web 全量在 1–2 workers 下 1710/1710 通过；默认并发 `yarn verify` 三次有 3/1/1 个五秒 UI 超时，失败文件单独运行均通过。日志：`/tmp/ticket08-verify*.log`、`/tmp/ticket08-web-limited2.log`。

待办：06 仍 claimed，08 保留 open。09 需证明分页、上市、历史周期及 Hyperliquid 毫秒时间映射；18 接入页面。证据见 `history-source-research.md`、`../history-and-eligibility.md` 与工单08。

## 最终补验（2026-10-27）

06现已resolved。08本轮查因修复配置就绪竞态并完成默认完整verify（root3316通过/8跳过、web1711通过）及生产build，工单追加Answer并resolved；不改变09/18生产接线边界。精确基线、代码文件哈希、失败/回归及正式命令日志见[最终验收](08-final-validation.md)。
