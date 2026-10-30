# 实施阶段历史记录

从工作地图移出以保持单文件预算；以下claimed/待签收均为当时记录，最新状态以各工单Status和map-acceptance为准。保留原文与证据链接。


逐票签收结论见[完成验收记录](map-acceptance.md)（08—11、20、19、15、16已resolved）。
- 2026-10-29：[18](issues/18-funding-page-and-read-api.md)已claimed并实施（待签收）：正式A页与只读API，后台市场轮询、排名指纹跨页；用户决定真实历史适配器与合约身份映射另开[22](issues/22-history-adapters-and-contract-identity.md)（21增依赖22），旧当前费率表保留为折叠视图。见[18实施交接](evidence/18-implementation-handoff.md)。人工开仓仍关闭。
- 2026-10-29：[13](issues/13-exact-prefill-and-confirmation.md)已claimed并实施（待签收）：A页详情内精确两腿预览/确认/长按接受，内存回执；持久身份与恢复归14。见[13实施交接](evidence/13-implementation-handoff.md)。人工开仓仍默认关闭。
- 2026-10-29：[14](issues/14-durable-submission-and-resume.md)已claimed并实施（待签收）：提交前每意图localStorage持久记录（失败不发送），丢响应按原id查询，服务端按预览到期/消费/未知证明迟到不可接受才释放；刷新/跨页恢复真实回执（含dust、在途≠成交、隔离原样），按候选只读列账本意图。见[14实施交接](evidence/14-implementation-handoff.md)。人工开仓仍默认关闭。
- 2026-10-29：用户签收[14](issues/14-durable-submission-and-resume.md)，已resolved；授权继续下一张可实施工单，[17当前认领与金额证据](issues/17-current-claims-and-attribution.md)由Codex claimed。
- 2026-10-29：[17](issues/17-current-claims-and-attribution.md)已实现待签收：持久认领命令由正常engine重验后原子入账；用户显式选量及Boros证据，保留剩余未归属与切片金额UNKNOWN。见[17实施交接](evidence/17-implementation-handoff.md)。人工开仓仍默认关闭。
- 2026-10-29：用户签收[17](issues/17-current-claims-and-attribution.md)，状态已resolved，授权将14签收与17实现一并本地提交。默认完整`yarn verify`（5369通过、8跳过）和Web production build通过；见[17实施交接](evidence/17-implementation-handoff.md)。未push或启用交易。
- 2026-10-30：[22](issues/22-history-adapters-and-contract-identity.md)实现已交付并双轴复审：五源只读历史适配器、unsigned CrossEx/native产品映射及独立经济/口径证明、18/12共享生产接线、限流保护与公开探针。当前出口Binance451/Bybit403，未证能力继续UNKNOWN；五源公开校准未全部验收，22保留claimed，21依赖保留。完整门禁另修复既有用户指南提示计时竞态；最终验证/提交见[22交接](evidence/22-implementation-handoff.md)。人工开仓仍关闭。
- 2026-10-30：用户选择“按UNKNOWN签收实现，公开校准另开跟进票”，[22](issues/22-history-adapters-and-contract-identity.md)已resolved（实现`67c1a83`）；新增[23公开校准补验](issues/23-public-history-calibration.md)为open，21增加23依赖。签收仅接受明确的UNKNOWN边界，不将未取得的公开证据改为PASS，不启用开仓。
- 2026-10-30：[23](issues/23-public-history-calibration.md)已claimed并补9次低频公开请求及[原始响应/头/哈希、规则与预算核对](evidence/23-public-calibration.md)。Aster/OKX/HL成功；Binance451、Bybit403与真实冷却/扣账证据缺口仍UNKNOWN。23尚未resolved，21依赖保留；待合规访问样本及自然限流/隔离测试证据，不擅自换出口或再次默认签收。人工开仓仍关闭。
- 2026-10-30：[23](issues/23-public-history-calibration.md)resolved。JA补验、官方/CCXT规则与冷却修正已交付，全量门禁通过；未观测限流/共享IP仍UNKNOWN，21保留限制，开仓关闭。
