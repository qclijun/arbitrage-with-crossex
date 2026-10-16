# 本机延迟重放与被动采集

工单 07 的标准库 Python 工具：`scripts/latency_report.py`。它读取 06 已生成的
v1 JSONL，提供配置/时段/操作/冷热分层和可复核的 PASS/FAIL/UNKNOWN 报告。
不导入交易引擎，不打开 SQLite，不读取密钥，不发送网络请求。

**当前真实测量里程碑为 UNKNOWN。** 06 的正常 GC 稳态 RSS 开销尚未验收，
本次没有启动应用、启用观测、重启、实盘查询或制造交易。
工具的固定样本通过不代表真实基线或池化优化通过。

## 离线复现

在仓库根目录执行（Python 3.10+，无第三方依赖）：

```sh
python3 -m unittest discover -s tests/latency -v
python3 scripts/latency_report.py replay scripts/latency-report.example.json --output /tmp/latency-evidence
```

示例使用固定的脱敏样本，结果必须为 UNKNOWN；不是本机测速数据。
stdout 为短 JSON，含结论和保存报告的绝对路径。JSON 报告可直接打开。
退出码 0 表示报告成功生成，包含 FAIL/UNKNOWN 结果；输入/写出失败返回 2，
不将异常信息或原始记录打印到终端。验收自动化必须读取报告中的 `status`。

## 真实数据采集

仅在已有、经授权运行的观测版本产生明细后执行一次：

```sh
python3 scripts/latency_report.py collect --source /ABS/DATA/engine-observation --output /ABS/EVIDENCE/latency-copies
```

这是被动读取已有明细并保存路径/SHA-256/writer status 索引的采集入口，增加的 API 请求数为零，
因此不消耗额外限流预算。不会为了凑样本加快 tick、发起只读探针、
启动第二个引擎或切换配置。没有观测文件会得到空索引和 UNKNOWN。
源目录与输出目录树必须分离。源文件始终只读，不额外复制明细；索引只保存文件元数据及明确白名单中的 writer 计数，
不写认证头、异常文本、原始明细、嵌套请求/响应字段。

采集前后 status 变化会将索引标记不完整。中间截断行、缺失请求回执、
序列缺口、非零丢弃/失败计数、最终 writer seq 与完整输入尾部不符都会缺证。
运行中的 status 可能落后，不能靠一次快照证明完整。
采集返回的 `files`/`statusFiles` 可直接填入 manifest。重放会核对索引中的哈希，
源文件继续追加、改变或已轮转删除则不能宣称重放了原快照，返回缺证/失败。
重放需在源文件仍被保留时完成；索引不延长原明细的保留期限。
多个 run 应各保留对应 status；只剩最新 run 的 status 无法证明旧 run 完整。

## Manifest

复制 `scripts/latency-report.example.json` 为自己的清单，再填写真实证据。
路径相对于 manifest 所在目录，或使用绝对路径。只填写机器/账号/路径的别名，
不要填写真实账号 ID、代理认证 URL、环境变量或凭据。

- `baseline`：原路径纯观测配置名；`configurations` 记录各配置的代码版本、配置说明、
  machine/account/route 别名。机器、账号和直连/代理路径须一致。
- `operations`：必须预先声明主要操作；缺失操作不能被静默忽略。建议只读基线
  分别列 `sdk-order-read`、`public-book`，按实际既有路径选择；外层 `order-read`、
  `refPrice`、`bestQuote` 与内层 SDK/盘口调用各自成组，不能相加为网络请求数。
- `windows`：每项有正整数 `group`、`config`、UTC 毫秒半开区间
  `[startUtcMs,endUtcMs)`、`files`、`statusFiles`、`evidence`。
  至少三组，每组包含每种配置一次，基线排第一且各组顺序相同，时段不重叠。
  例如 baseline1→pooled1→baseline2→pooled2→baseline3→pooled3；
  同一清单也可声明等待优化和组合配置，分别对原路径比较。
- `files` 包含覆盖所需 run 的完整文件集合；区间筛选用于样本分组，
  final status 核对使用文件内完整 run 尾部。不要把跨边界请求拆开后当完整样本。
- 每配置、每主要操作、每组至少 100 成功样本，冷热分层不足各自 UNKNOWN，
  不从热连接推断冷连接；比较总状态保守要求冷、热两层的预算都有证据。
  现有 v1 writer 的 connection 全为 UNKNOWN，因此真实冷热验收目前无法通过。

`observationOverheadEvidence` 可引用经审计的 06 开销验收 JSON 文件。
各 window 的 `evidence` 可分别引用 `safety`、`resources`、`queue`、
`noNewErrors`、`confoundsCleared` 的独立审计文件，例如：

```json
{"resources":{"artifact":"audit/window-1-resources.json"}}
```

审计文件的形状为 `{"status":"PASS|FAIL","metrics":{...}}`；不是 manifest 中
写一个 PASS 就被接受。工具读取文件并记录 SHA-256，输出只保留数值/布尔 metrics。
这是显式外部证据声明，工具不宣称独立复验其采集方法或排除了全部混杂。
没有审计文件时保持 UNKNOWN，不能为通过验收填写虚假的 PASS。

resources 的 metrics 必须有 `rssDeltaMiB`、`steadyState: true`、`boundedGrowth: true`、
`connectionsMax`、`connectionLimit`、`fdMax`、`fdLimit`；RSS 增量上限 32 MiB，
连接及 FD 不得超过明确的正数上限。queue 的 metrics 必须有毫秒单位
`n`、`p50`、`p95`、`max`，n 至少 100。若独立排队时间不可测，不得拿 RTT 替代。
其他外部审计的安全与无混杂结论必须由证据负责人核实。

## 数值与判定

成功耗时为本机 `receipt.monoMs - send-entry.startedMonoMs`，使用 nearest-rank
百分位；报告 p50/p95/max 和样本数。另列全部已完成请求耗时。
错误、限流、未完成与无法配对的请求保留在该操作总请求分母内；重复复制的
相同 `(run,seq)` 只算一次，冲突副本缺证。失败样本不混入成功百分位。

池化判定同时要求：合并 p95 改善至少 10%；至少 2/3 时段 p95 改善至少 10%；
合并 p50 恶化不超过 10%；每个时段 p95 恶化不超过 max(基线 p95 的 10%,20ms)。
合并百分位从全部样本计算，不能平均各组百分位。另逐组比较错误类别占全部请求
的比例；新增错误/限流、资源越界或外部安全失败直接 FAIL。
证据不足、丢弃、未知冷热、开销准入未通过、混杂未排除则 UNKNOWN。
FAIL 优先于 UNKNOWN；性能合格不能抵消安全失败。
仅基线配置的报告没有优化 PASS，baseline 状态与 comparisons 分开。

本地对冲响应按可验证的同 run/deal/client 关联，报告已确认 A 数量到 B 登记、
登记到外层 create 入口、入口到回执。新增 A 累计确认按数量 FIFO 分配给 B 登记，
输出每份数量和延迟；没有零起点、旧订单/重试/取消导致无法归因时 UNKNOWN。
未发送或缺少回执的链路不称为完整响应。

数量使用 Decimal；在可验证的零起点和连续累计确认下，计算本地确认净数量
E(t)=A 已确认成交−B 已确认成交，输出峰值、非零持续时间和 ∫|E|dt（base·ms），
只统计到最后一条记录，未结束的暴露为右截断。重复累计确认不重复记数量。
B 预留不会减少 E；`unreservedBase` 单列。按 run/deal 输出，绝不将不同市场
的基础币相加。该口径是本地确认时刻的暴露，无法代表 venue 原生成交时刻。

v1 没有原生成交身份、跨 venue 校准时钟、POC 拒绝标签、确定的 Maker/Taker 身份，
因此真实经济暴露峰值/持续/积分、精确源年龄、POC 拒绝率和成交身份保持 UNKNOWN。
超额对冲只在完整数量证据下检查；dust 未有 sizing 证据则 UNKNOWN。
后续自然交易需要另行授权，不能为本票制造真实写操作来补样本。

## 容量与保留

所有采集索引与聚合报告都进入同一个专用输出目录的
`reports/latency-<ms>-<random>.json`。新建输出根目录和 reports 目录为 0700，
新文件 0600；已有目录不擅自 chmod。只轮转这个名称空间，合计 30 天/10 MiB，
先到者生效；每次写出执行轮转，未运行工具时没有后台定时清理。
同一安装的 collect/replay 始终使用同一个输出目录，不分别建立各自预算。
不生成第二份结构化明细，全部明细仍仅存在于 06 writer 的 7 天/100 MiB 总预算中；
源账本、日志、其他文件不参与清理。

重放限制所有输入合计 100 MiB/100000 行、每行 16 KiB、manifest/采集索引各 256 KiB，
最多 256 时段，每时段或每次采集最多 256 个文件。超限拒绝，按时段缩小输入后重放。资源限制作用于独立离线工具，
不占用引擎的异步 1 MiB 缓冲，也不证明交易进程 RSS 达标。

9 号票的 `hedge-wait` 明细会显示在新增 `hedgeWait` 摘要中，按 run/deal 保留最新状态。
`confirmedUnhedgedBase` 与 `unreservedBase` 分开；缺失时长/数量保持 null，
`actualEconomicStatus` 和 `sourceTimeStatus` 仍 UNKNOWN。详见 [等待说明](HEDGE-DEPENDENCY.md)。

10 号票增加可选 `optimizationMatrix`、`referenceConfig` 和 `trialEligibility`，
分别判断池化、等待及组合，并验证独立回退/最终参数证据；旧清单不产生四配置试用资格。
使用 [latency-rollout.example.json](../scripts/latency-rollout.example.json) 和
[验收与回退说明](ENGINE-OPTIMIZATION-ROLLOUT.md)。真实门禁未通过时仍为 UNKNOWN。
