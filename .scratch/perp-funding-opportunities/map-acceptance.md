# 工作地图：逐票完成验收记录

由[工作地图](map.md)拆出；每张票签收后在此追加结论与链接（按签收顺序）。

## 08完成验收

- 2026-10-27：[08](issues/08-history-contract-and-eligibility.md)已追加Answer并resolved；现有历史纯计算/来源归一化验收补齐，本轮修复配置就绪先于钱包初始化/旧root恢复的竞态，确定性回归先失败后通过。默认完整verify：root3316通过/8跳过、web1711通过；生产build通过。详见[最终验收证据](evidence/08-final-validation.md)。
- 09/10保持open并按各自验收签收；09和11不再受08阻塞，当前可按依赖认领09/11/20，10仍等待09。此前默认全量失败已保留查因与修复结果，21仍须在正式最终版本完成全部准入门槛；本次不宣称生产数据覆盖或启用人工开仓。

## 09完成验收

- 2026-10-28：[09](issues/09-history-collection-and-cache.md)已追加Answer并resolved。审查修复：刷新每10分钟一轮/截止4分钟（用户确认），每轮重读的腿在两次发布间保持fresh；同cutoff较窄新读按窗口保留；ASTER默认1秒间隔。默认完整verify root3318/8跳过、web1711，生产build通过；见[最终验收证据](evidence/09-final-validation.md)。10不再等待09；真实适配器、预算实测与18接线待后续，21仍须最终复验。

## 10完成验收

- 2026-10-28：[10](issues/10-directed-pairs-and-ranking.md)用户签收，追加Answer并resolved。纯候选/排名模块（8df73e1）经双轴审查修正`rate-basis-mismatch`误判（c54f044），补舍入同分与09宽读路径测试；root 3319/8跳过、web build通过，默认并发web偶发UI超时仍归21复验。18不再受10阻塞（其余依赖保留）；页面/API、跨页固定snapshot与评估时间由18承接，不启用交易。

## 11完成验收

- 2026-10-28：[11](issues/11-costs-and-payback-scenarios.md)用户签收，追加Answer并resolved。纯情景`scenario.ts`＋证据适配`cost-evidence.ts`（dd69055），双轴审查后修正未成交maker不计价差收益、穿越盘口阻断及读取抛错隔离（73d48ea）；单测16/16，默认verify root 3335/8跳过、web 1711，build通过。12不再等待11（其余依赖保留）；严格10秒准入及账户借款/换汇证据归12，A页接线归13，不启用交易。

## 20完成验收

- 2026-10-28：[20](issues/20-ledger-schema-and-upgrade-compatibility.md)用户签收，追加Answer并resolved。账本版本/迁移/备份/恢复协议（899a370）及审查修正（7f1c597）；v1屏障使历史release启动即失败，安装器按标记拒绝回滚，恢复仅限迁移后无写入。root 3365/8跳过、build通过，web默认并发偶发超时归21。15/19不再受20阻塞（其余依赖保留）；领域迁移须经`LEDGER_STEPS`，真实升级端到端由19/21验证，不启用交易。

## 19完成验收

- 2026-10-28：[19](issues/19-admission-switch-and-legacy-entrypoints.md)用户签收，追加Answer并resolved。持久准入开关（默认关、版本变化即关、代次原子接受）与POST /deals用途分流（reduce/旧客户端/boros-strategy/manual冲突门/funding-two-leg拒绝），3f2e042＋3b61853；root 3408/8跳过、build通过，web默认并发两项既有偶发超时归21。12须经`admit`接受，18只读阶段可消费开关状态；不启用交易。

## 15完成验收

- 2026-10-28：[15](issues/15-strategy-slices-and-reconciliation.md)用户签收，追加Answer并resolved。策略切片数量账（97beee0＋a6b5744）：实际成交增量幂等记账、逐合约基线对账与显式恢复、未对账合约阻断新增风险、切片限定减仓；默认verify/build全绿。16可消费切片与对账；12接入创建/加仓，17接入认领；不启用交易。

## 16完成验收

- 2026-10-29：[16](issues/16-slice-risk-applicability.md)用户签收，追加Answer并resolved。按切片数量限定Risk适用（5bb7d06＋788e03b）：仅已对账的浮动两腿配对数量解除Boros覆盖要求，其余风险不变；报告v2与Python连续缺口链一致。12不再受15/16阻塞（09/11/19/20已resolved），可开始；不启用交易。

## 12完成验收

- 2026-10-29：[12](issues/12-preview-evidence-and-admission.md)用户签收，追加Answer并resolved。服务端预览证据、原子接受与幂等（fbf71bd＋df5d796＋9e2479c）：engine自有杠杆，预览只读10秒、按可见精度绑定，接受重读重判后在准入事务内写意图/切片/deal，同id幂等、回执覆盖终态。13（还需18）及14可消费；生产端口待18接入，不启用交易。

## 18完成验收

- 2026-10-29：[18](issues/18-funding-page-and-read-api.md)用户签收，追加Answer并resolved。正式A页与只读API（ad58fb0＋2aed7e5）：内存只读排名、排名指纹跨页、后台当前费率轮询、旧表折叠；生产来源为空如实未接线（22承接）。13、17不再受18阻塞（其余依赖保留），22可开始；不启用交易。
