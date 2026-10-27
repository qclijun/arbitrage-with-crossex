# 工单09最终验收（2026-10-28）

## 实现与证据绑定

后台采集/只读缓存实现：`4fe5f6d`；本轮基线`056e1daf2d37476c147c639450b0d6a88ec2d139`，分支`docs/perp-funding-opportunities`。范围仍为用户确认的可注入`FundingHistorySource`端口、刷新器与只读缓存；不含真实场所HTTP适配器、index.ts/AppDeps接线或路由（18）。预算依据[07研究](history-source-research.md)，合成测试不证明生产历史完整。

本轮修复随提交`fix: keep funding history fresh between refresh rounds (09)`保存。通过验收时文件SHA-256如下，代码/测试git diff SHA-256为`42c423a0745789f6f296f6e5a2e1a158b206a7e4a9bbe0c89261f56cda8ae229`。

- `src/core/funding/history-cache.ts`：`305b8e0f80458e036baa5db685ea56fbbd9308cf54aebf5adc0d97ac455b121f`
- `src/core/funding/history-collector.ts`：`f8eb16abb58b19aa791d41212a465f0a57c3ea3b775cee679f170ea6589e3806`
- `tests/helpers/funding-history-stub.ts`：`505419a8786fc11d95c39797ceac067057cb7a34590171f0e6b0c23d74005b32`
- `tests/unit/funding-history-cache.test.ts`：`50a72bef4f566c80a2735df7ffecfd0ac50be87945b5b580ffe0331d8742fabd`
- `tests/unit/funding-history-collector.test.ts`：`bdb4c9650108299b7798228c988160cb8e7d33b9f2f393374dcb1c88acf5f79a`

## 审查发现与修复

基线默认`yarn verify`已通过（root 3316/8跳过、web 1711），build通过；双轴审查标准轴无硬违规，规格轴发现以下缺陷，均先写失败回归再修复：

1. **每轮必现stale空窗**：原15分钟一轮、12分钟截止、整轮结束才发布；轮内较早核验的腿在下一轮发布前超过15分钟。回归（3条Binance腿/2并发、每页4秒）在16:30/31:30/46:30观察到stale。用户2026-10-28确认改为**每10分钟一轮（整10分后1分钟启动）、截止4分钟**：间隔加硬停止（4分钟+2×5秒+1秒抖动）≈14.2分钟<15分钟，每轮重读的腿在两次发布间保持fresh。每轮请求/并发/超时/重试上限（240/40/2/5秒/1次）不变，单位时间请求约为原计划1.5倍。每小时0分至首轮发布期间cutoff落后stale，是01规则要求，保留。
2. **同cutoff较窄新读被丢弃**：原merge在新读未覆盖旧读的最远范围时保留旧读，违背“新抓取的partial也可能fresh”。现在总采用最新核验读数；同cutoff且旧读覆盖更远时另存为`wider`，按窗口选取覆盖它的最新读数，长窗口沿用旧证据及原verifiedAt，短窗口用新核验；两读间改值互相登记为冲突；跨cutoff仍不拼接。
3. **ASTER间隔无依据**：07未给Aster IP限额，原0ms违背“未实测前按更低吞吐”；移除覆盖，采用默认1秒间隔。

标准轴判断项（单写者仅靠约定、`Date.now()`内联、`revised`字符串比较与评估器标度比较两套规则、`HistoryCacheView`字段重复等）未改：评估器按标度去重且忽略窗口外事件，无可达错误结果；挂起读不响应abort仍可能超并发，为端口契约已记限制。

## 本轮命令与结果

| 命令 | 退出状态与结果 | 完整日志 |
|---|---|---|
| `yarn vitest run --project unit tests/unit/funding-history{,-cache,-collector}.test.ts tests/unit/funding-ranking.test.ts`（基线） | 0；38/38 | `/tmp/ticket09-final-focused.log` |
| `yarn verify`（基线，默认完整配置） | 0；root 141文件3316/8跳过，web 109文件1711 | `/tmp/ticket09-final-verify.log` |
| `yarn --cwd web build`（基线） | 0 | `/tmp/ticket09-final-build.log` |
| 两条新回归（修复前） | 1；分别stale样本及verifiedAt仍为T+M | 本会话运行输出 |
| 同上四个文件（修复后） | 0；40/40 | 本会话运行输出 |
| `yarn verify`（修复后，默认完整配置） | 0；root 141文件3318/8跳过，web 109文件1711/1711 | `/tmp/ticket09-final-verify-fixed.log` |
| `yarn --cwd web build`（修复后） | 0；保留既有大chunk提示 | `/tmp/ticket09-final-build-fixed.log` |

Node v24.21.0、Yarn 1.22.22；未降低workers、单跑替代或放宽超时。测试为离线stub来源与假时钟；未运行live或连接真实场所。

## 验收对照

15分钟边界、跨UTC整点、失败不延寿、半成快照不可见、冷启动、限流、预算耗尽、场所局部失败、预检拒绝旧snapshot/cutoff落后/不合格，均由`funding-history-{cache,collector}.test.ts`覆盖；读路径无来源依赖，测试证明在途轮次时读取不增加来源调用；并发/请求/重试上限有断言。本票无路由，server/app.inject条款由18承接。

## 签收与边界

09按确认范围resolved；10不再等待09。真实适配器（分页/上市/周期证据、HL毫秒映射）、Retry-After/权重头解析、公开样本实测校准预算与18接线仍待后续；21须在最终版本重新完成全部门槛。未启动服务、部署或交易。
