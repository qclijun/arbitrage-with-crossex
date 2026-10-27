# 工单08最终验收（2026-10-27）

## 实现与证据绑定

历史证据/资格纯模块实现：`9ab7724`；本轮基线：`6f18ca791fd23187d90ee7b80f9abee1d5a0f82d`，分支`docs/perp-funding-opportunities`。历史源边界继续依据[07研究](history-source-research.md)，不声称合成测试证明生产历史完整。08未接真实采集、页面/API或交易路径。

本轮另修复阻碍默认全量验收的配置就绪竞态，随提交`fix: wait for wallet initialization before setup readiness`保存。以下为通过验收时三个代码/测试文件的SHA-256；其git diff SHA-256为`9a97a0a1b5a63610807ac4de39673c85a4da255609dc75fe26c615090ba5d1d9`。提交后可按文件哈希核对，不把未提交变更冒充已有提交。

- `web/src/panels/trackedAddress.tsx`：`f5c1f2b03675c3451e673b1bdfb44641df5568b9474f883f278742d1c476e485`
- `web/src/panels/setup/setupState.ts`：`b7b901093363f3e1abc4a2632de3ba1d3b5cd88e9000b3336e6dd98f72f19338`
- `web/src/panels/setup/setupState.test.tsx`：`45162c6f9c678dae79f58fdae99519f03c2cbaade61d870e7ad17a282314f694`

## 失败、定位与修复

- 默认`yarn verify`基线退出1：root 141文件、3316通过/8跳过；web 107文件通过/2失败，1708通过/2失败。失败为`App.setupOnce.test.tsx > opens settings once`未找到Settings对话框，以及`setupState.test.tsx > a live approval is done`实际missing、预期done。
- 已确认机制：`useSetupState.isLoading`只合并三个查询的pending；`TrackedAddressProvider`还要异步读取浏览器账户，再通过effect恢复旧agent root。因此查询ready不保证钱包地址已就绪，配置可能过早消费missing状态。
- 新增确定性回归：预先填满三项查询缓存，挂起`eth_accounts`；读取未完成时必须仍loading，返回空账户后完成agent-root恢复才ready且钱包done。旧代码稳定失败（预期true、实际false），修复后通过。
- 最小修复：钱包上下文暴露`isInitializing`，覆盖初次读取及必要的旧root恢复；配置加载状态包含它。未改变钱包选择/登录/交易权限、800ms长按、10秒预览、并发或测试超时设置。
- PairTicket此前5秒超时本轮未复现：默认基线/修复后重挂载幂等测试分别4699/4603ms。双次真实800ms长按加两次装载/预览使其贴近总时限，是性能诊断线索；没有把这一推断当作所有历史超时的已证根因。21在正式实现版本继续观察和执行完整门槛；不能挑选单跑或降并发结果替代。

## 本轮命令与结果

| 命令 | 退出状态与结果 | 完整日志 |
|---|---|---|
| `yarn vitest run --project unit tests/unit/funding-history.test.ts` | 0；11/11 | `/tmp/ticket08-final-focused.log` |
| `yarn verify`（修复前） | 1；上述两项web失败 | `/tmp/ticket08-final-verify-baseline.log` |
| `yarn --cwd web test src/panels/setup/setupState.test.tsx`（回归先行） | 1；新回归稳定失败，原6项通过 | `/tmp/ticket08-wallet-readiness-red.log` |
| `yarn --cwd web test src/panels/setup/setupState.test.tsx src/panels/trackedAddress.test.tsx src/App.setupOnce.test.tsx` | 0；25/25 | `/tmp/ticket08-wallet-readiness-green.log` |
| `yarn verify`（修复后，默认完整配置） | 0；root 141文件、3316通过/8跳过；web 109文件、1711/1711 | `/tmp/ticket08-final-verify-fixed.log` |
| `yarn --cwd web build` | 0；生产bundle完成，保留既有大chunk提示 | `/tmp/ticket08-final-build.log` |

运行环境Node v24.21.0、Yarn 1.22.22；无降低workers、单跑替代或重试挑绿。测试使用离线合成数据、MSW/fake venue；未运行live测试或连接真实交易终端。Python工具未变，相关独立suite不适用本票变更。文档记账后另执行链接、依赖、预算及空白检查，结果记入交接。

## 签收与边界

01/07已resolved，06已定稿解除阻塞；08的纯计算/来源归一化及本轮正式默认verify/build验收已满足，可resolved。09/10仍保持open，由各自验收单独签收；09与11不再被08阻塞，10仍依赖09。生产分页/上市/周期/HL时间映射、真实来源适配及18接线继续按原任务边界取证；21仍需在最终正式实现版本重新完成全部集成/UI/迁移等门槛，不继承本次为产品准入PASS。

## 记账后检查

45份Markdown本地链接、21票依赖DAG、01—08 resolved/09—21 open状态及08 Answer检查通过；代码/测试文件与补丁哈希吻合证据，git diff空白检查通过。全仓833文件文本预算通过；日志`/tmp/ticket08-final-doc-checks.log`、`/tmp/ticket08-final-size.log`。当前可按依赖认领09/11/20，没有自动认领下一票。
