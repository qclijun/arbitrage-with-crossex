# 独立及组合验收与回退

10 号票交付四配置验收报告及离线回退证明。生产保持默认关闭；本票不部署、重启、
启用、触发自然交易或额外下单。06 正常 GC 稳态 RSS 与 07 真实基线未通过，
因此最终连接数、性能收益及受控试用资格均为 UNKNOWN。

## 四配置重放

沿用 `latency_report.py collect/replay`，没有新采集器、探针或第二个引擎。

```sh
python3 scripts/latency_report.py replay scripts/latency-rollout.example.json --output /tmp/latency-evidence
python3 -m unittest discover -s tests/latency -v
```

该示例只声明配置和离线安全/回退审计，没有真实请求样本，结果必须 UNKNOWN。
collect 仍只索引已存在的明细，不读取密钥、打开账本或访问网络。
原始明细、缓冲、报告保留限制沿用 [LATENCY-REPORT.md](LATENCY-REPORT.md)。

`optimizationMatrix` 明确映射四个不同配置名：baseline、pool、wait、combined。
配置必须完整且唯一，baseline 对应 manifest.baseline；每配置记录版本、机器、
账号与路由别名、poolMaxSockets 及 skipUnrelatedMakerWait。原路径/仅等待的池参数
必须为 null，原路径/仅池化等待开关为 false，另外两种为 true。
所有时段使用相同机器、账号和网络路径，至少三组交替，每组四配置顺序一致。
每主要操作、每配置、每组成功样本至少 100；冷热分层分别足量，错误/限流留在分母。

- 仅池化和组合相对原路径：合并 p95 至少改善 10%，至少 2/3 时段改善 10%；
  合并 p50 恶化不超过 10%，逐组 p95 恶化不超过 max(原 p95 的 10%,20ms)。
- 仅等待优化的只读 RTT 使用上述 p50/逐组 p95 不回归门槛；不要求它让独立签名查询
  快 10%。对冲依赖收益由可控 promise 经 tick 取证，真实毫秒收益仍 UNKNOWN。
- 组合还分别对照仅池化、仅等待，使用不回归门槛；单项通过不能掩盖组合回归。
- 全部比较均包含冷热分层、逐组错误类别比例、队列、资源、安全和混杂证据。
  已知 FAIL 优先于 UNKNOWN，性能收益不能抵消安全或资源失败。

旧 manifest 不声明 optimizationMatrix 时保持 07 的比较语义，但不能得到四配置
试用资格。每个比较增加 referenceConfig，不能把组合对单项的结果误读为对原路径。

## 外部审计与试用资格

`trialEligibility` 区分各优化及组合的资格、检查项与参数。所有结论由原始重放和
显式链接审计共同决定，自动启用永远为 false；即使 PASS 仍需另行批准生命周期操作。
这是预算判断，不是统计显著性、长期 SLA 或真实经济收益证明。

沿用有界审计文件 `{status: PASS|FAIL, metrics: {...}}` 与 SHA-256 provenance。
工具检查必需字段，但不声称独立认证审计方法或真实采集。不能手填虚假 PASS。

| manifest 字段 | 必需 metrics |
| --- | --- |
| observationOverheadEvidence | groups ≥3、minTicksPerGroup ≥1000、everyGroupWithinBudget、mergedWithinBudget、steadyState、boundedGrowth 均 true；rssDeltaMiB ≤32 |
| poolSelectionEvidence | maxSockets 为 1..16 整数且与 pool/combined 声明一致；baselineCompared、concurrencyTested、readOnlyCompared 均 true |
| offlineSafetyEvidence | makerDependency、missingPrice、partialCancelRace、dustSizing、unknownFreeze、intentEdits、outageRecovery、transportUnknown、authRouting、credentialRetirement、observationBounds、clockUncertainty、reservedExposure 均 true |
| rollbackEvidence | pool、wait、combined、inFlightDrained、ledgerPreserved、noResend 均 true |

window 的 safety/resources/queue/noNewErrors/confoundsCleared 审计仍全部必需。
资源审计须包含稳态 RSS、增长边界、明确连接/FD 上限以及切换期间退役池高水位；
池化/组合窗口资源还须记录实际 poolMaxSockets 与选值一致、maxGenerationSockets
不超过该单 generation 上限，以及 transitionHighWaterIncluded: true；聚合连接上限
可覆盖多代退役重叠，不能误用单代上限限制合法在途连接。
参数审计还须关联基线、并发和真实只读比较，不能拿 08 的合成候选选值作为最终参数。
缺文件/字段为 UNKNOWN，明确 false/FAIL、资源越界或配置不匹配为 FAIL。
06 只有强制 GC 后结果或短时 RSS 高水位不能填写正常 GC 稳态通过。

## 独立回退

等待开关在首次订单观察与投影完成后读取一次；捕获之前的改动可影响当前 tick，
捕获之后的阶段保留该选择，下个 tick 再读取。回退测试在 B 写请求阶段切换。
池化沿用 EngineTransport.configure(null)：退役 session 不接受新操作，在途操作链的
确认/分页继续使用原账号和路由，链结束后释放，新操作走原客户端。不强停引擎或打断请求。
只关闭其中一项不会关闭另一项，不改变意图或清理账本；UNKNOWN 写保留 PENDING，
下一 tick 按原 client id 探测，不换池重发。已有客户端切换错误和未知探测规则继续适用。
若运行时无法安全完成切换，保留证据并沿用既有告警/探测，不承诺瞬时回退。
本票没有加入 HTTP/环境启用后门或新的全局控制器。

离线证据通过真实 SDK/适配器、nock 外部传输、临时 SQLite 和 tick 入口验证四配置；
在 B 写请求挂起时分别关闭池、等待或两者，覆盖接受后的同链确认和 503 UNKNOWN 后原标识探测。
配合 08 生命周期/真实本机 TLS 与代理 fixture、09 依赖与故障反例，不能用 FakeVenue
单独代替传输证明。证据见 [验证记录](validation/engine-optimization-rollout-2026-10-16.md)。

## 后续另行授权的自然交易观测清单

- [ ] 先验证 06、07 和四配置真实门禁；保存本机版本、账号/路径别名、最终参数和授权范围。
- [ ] 只观察原计划交易，不加单、不加速只读频率、不人为制造失败或增加资金。
- [ ] 关联 Maker 累计成交确认、B 写前登记、发送入口、回执和真实成交；记录单位、实际身份及归因缺口。
- [ ] 分开报告未预留义务和按实际成交重建的净暴露；给出峰值、持续时间、积分及右截断/跨 venue 钟差限制。
- [ ] 记录全部请求、POC 拒绝、错误/限流、排队、冷热与资源，样本不足不外推百分位收益。
- [ ] 重复获取、超额对冲、UNKNOWN 后重发、绕过冻结/取消/校验、串账号、语义变化或新错误/资源越界直接 FAIL；保留证据，按对应开关受控回退。
