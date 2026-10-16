# 引擎专用签名池离线验证

日期：2026-10-16。分支：dev_0929，变更基于 `1e2535f`。
实现与范围见 [ENGINE-SIGNED-POOL.md](../ENGINE-SIGNED-POOL.md)。

- `yarn verify`：Node 24.19.0；两端类型检查通过；核心/服务端 131 文件、3114 通过、8 跳过；网页 105 文件、1582 通过。
- 新增 SDK/生命周期/临时 SQLite 引擎入口 11 项；本机 TLS/CONNECT 综合测试 1 项。
- 延迟报告 Python 回归 11 项通过；`git diff --check` 通过。
- 初次最终检查因新增 catch 分支的 TypeScript 联合类型推导失败，已显式注明 CreateOutcome/CancelOutcome 泛型并重验通过。
- 重置/超时码在 Axios 适配器边界注入；真实 reset 从本地 TLS origin 主动断开验证，写只到达一次。nock 的 replyWithError 配合自有 Agent 在本环境未能可靠完成，未用它冒充真实 reset 测量。

## Standards

独立审查未发现文档规范违反或必须修复项。可选的重复 timeout 建议已通过共享常量解决。
最终复查确认退役资源统计、关闭等待和显式结果类型安全；0 项剩余问题。

## Spec

独立审查确认引擎范围、SDK/数量语义、UNKNOWN/no-retry、账号/路由链归属、生命周期及默认关闭。
最终复查确认客户端获取失败不 fallback、退役 generation 计入资源；0 项剩余代码问题。

## 测量结论

[原始候选 JSON](engine-signed-pool-local-2026-10-16.json)只包含本地假凭据、合成 TLS origin/代理、每配置 16 个成功只读样本。
最终记录采集于全量离线测试并发运行期间，耗时包含竞争，不能作为性能对照。
1/4/8 均验证连接数上限及复用；1/4 出现队列，8 路并发的 8 上限不排队。
建议把 1 作为单写者串行路径的候选起点；最终生产值 **UNKNOWN**。

短时 RSS 高水位及 FD 计数不等于稳态增量；代理/参数切换允许在途旧 generation 与新池重叠，最终门禁必须包含这些连接。
07 真实原路径基线、06 正常 GC 稳态 RSS，以及最终组合对照仍未通过。工单保持 claimed。
生产没有启用入口变更，没有启动/重启应用，没有访问真实账户或执行交易。
