# 实施顺序与验收矩阵

Status: final — 2026-10-27最终共同理解已确认，06已resolved
来源：[06准入契约](acceptance-and-rollout.md)、[规格](spec.md)及01—05的Answer。此页是已定稿的后续实施依据，不是产品实现或启用证明；08—21已解除06阻塞，仍按真实依赖与验收推进。08—10此前获明确授权先实施；08、09已补齐默认完整验收并resolved，10仍待签收。

## 责任与依赖

| 票 | 唯一主要责任 | 关键输入 |
|---|---|---|
| [07](issues/07-history-source-research.md) | 官方历史能力、规则、分页与预算证据 | 01 |
| [08](issues/08-history-contract-and-eligibility.md) | 历史证据模型和纯资格计算 | 07及01 |
| [09](issues/09-history-collection-and-cache.md) | 后台采集/缓存/完整快照发布 | 07/08 |
| [10](issues/10-directed-pairs-and-ranking.md) | 纯有向候选、排名/过滤/分页 | 08/09及02 |
| [11](issues/11-costs-and-payback-scenarios.md) | 真实当前成本证据及金额情景 | 08及02/03、Q2期限 |
| [12](issues/12-preview-evidence-and-admission.md) | 服务端预览、原子接受及幂等/查询协议 | 09/11/15/16/19/20 |
| [13](issues/13-exact-prefill-and-confirmation.md) | A页精确参数、金额/费用、人工确认接线 | 11/12/18 |
| [14](issues/14-durable-submission-and-resume.md) | 持久提交身份、丢响应与刷新恢复 | 12/13/20 |
| [15](issues/15-strategy-slices-and-reconciliation.md) | 实际成交数量账、指定切片与对账 | 04/20 |
| [16](issues/16-slice-risk-applicability.md) | 逐数量Risk及consumer/历史语义 | 15/20 |
| [17](issues/17-current-claims-and-attribution.md) | 当前认领及诚实金额归因展示 | 15/16/18 |
| [18](issues/18-funding-page-and-read-api.md) | 正式A页和只读API | 09/10/19 |
| [19](issues/19-admission-switch-and-legacy-entrypoints.md) | 开关/代次及旧入口兼容、在途隔离 | 20及03/04 |
| [20](issues/20-ledger-schema-and-upgrade-compatibility.md) | 版本/迁移/备份/程序回退兼容基础 | 04及06 |
| [21](issues/21-integrated-readiness-and-enablement.md) | 跨票最终验证和人工启用准备证据 | 07—20全部正式交付 |

06已resolved，所有task移除06阻塞；其余完整边以各票Blocked by为准。10实现消费09缓存，已补齐09依赖。20定义通用版本/迁移协议，12/15等拥有领域schema；19定义开关/兼容，12消费它并拥有原子接受/幂等。18不重做10的领域排序，13不重做12的服务端校验，14不创建第二恢复执行器。单writer、十进制字符串及既有安全边界贯穿全部责任。

## 交付顺序

1. **事实及基础**：07可按既有01依赖独立研究。06完成后，从dev创建后续实现分支；先做20持久兼容基础，再做19关闭准入。08/09/10及11的领域工作可依真实依赖推进，不提前开放运行入口。20的完整关闭/排空验证由19/21集成补齐，不能把先做20说成已完成真实升级。
2. **只读观察**：07/08/09/10/18及19/20验收后，可独立交付A排名/历史详情。server闭门、旧入口不绕过、原执行不被误停的集成证明必须齐备。费用或执行区域未接线时明确不可用/UNKNOWN，不以0或原型fixture补全。此阶段不要求11—17已全部实现，但绝不开放新人工开仓。
3. **完整人工能力**：11、15、16及其余依赖准备后实施12；18/12完成后做13，再做14，17消费18及数量/Risk证据。11实现金额及费用数据，13接到A页；当前认领按17提供证据而非自动分配旧仓。所有开/加仓入口仍默认关闭；不足证据只阻相关风险，不能停正常reconcile。
4. **最终验收及启用准备**：21整合全部07—20证据，默认完整门槛通过，保留正式A页浏览器证据及支持范围。只报告可申请人工启用，用户另行明确开启；21 resolved或版本发布本身都不改变运行权限。观察交付、代码合入与部署/重启/实盘操作分别看待，不由本计划授权后者。

历史缓存是可重新取证的数据；重启无可用证据必须冷启动UNKNOWN，不能给旧数据换时间。实现可选择内存缓存，若落SQLite则服从20及唯一writer；不把历史缓存恢复成功当成执行/归属账已恢复，后者必须持久保全。

## 验收矩阵

以下均是未来正式实现的必测要求，未执行前不能填通过。每行证据至少记录实现提交、测试文件、命令及退出状态；浏览器证据注明隔离数据来源。单票负责最小行为回归，21证明跨票组合，而非机械重写单票单测。

| 场景 | 主要责任票 | 必须证明 |
|---|---|---|
| 不同周期、周期变化、去重/冲突、窗口边界、新币短窗口 | 07/08/09 | 官方能力与合成边界证据分开；完整且fresh才排名，UNKNOWN不补0 |
| 冷启动、半成快照、局部失败、刷新失败、超15分钟/跨UTC整点 | 09/18 | 页面只读缓存；失败保留原时间；stale停止排名/新开 |
| 全方向、同venue多合约、零/负/反向、真同分/显示舍入、分页 | 10/18 | 全局精确排序后分页、固定两腿、只观察不被执行白名单删除 |
| 实际费用与VIP假设、深度/FX缺失、正常/转换/平仓费用、D≤0/C≤0 | 11/13 | UNKNOWN不当0；数量及各腿名义金额正确，情景不冒充实际收益或硬成本上限 |
| 预览/提交当前证据、10秒边界、源陈旧/无时间、共同cutoff失效 | 11/12 | 每次重新只读取证，从读取到接受最多10秒；不延长原预览，不改时间冒充新数据 |
| 编辑/变价/警告变化、长按取消/过期、零负确认、到期转换授权 | 12/13 | 精确参数和费用绑定、最多10秒/800ms，新预览重确认；IOC无硬价格保护明确 |
| 同id并发/异业务、丢响应、迟到请求、终态partial/dust、刷新恢复 | 12/14 | 至多一个deal，不延长deadline；not-found不自证失败，页面不补单/回滚 |
| 首次/配置不明、关门接受竞态、重新开启、旧客户端/普通pair | 12/18/19 | 默认关闭、未接受旧预览不能复活、相关新风险不绕过；非机会减风险不套历史资格 |
| 已接受maker/转换、unknown/quarantine、逐单Stop、reduceOnly | 14/19 | 关闭入口不改原确认或停loop；真实取证/冻结/对冲继续，不全量Stop误停减风险 |
| 实际累积与B预留、指定减仓、共享合约、外部改仓、重复/迟到量 | 15/17 | 不跨切片扣量，不FIFO/按比例猜归属，UNKNOWN不抹缺口 |
| 4.03中0.36/3.67、四腿/三腿/纯两腿混合、Spread单计、HYPE缺证据 | 15/16 | 仅证明的浮动数量免Boros要求，价格/清算/执行风险保留，consumer版本不清历史告警 |
| 当前认领、来源/as-of、必要Boros证据、缺手续费/逐笔时间 | 15/16/17 | 显式选量且当前可对账，不倒填过去归属/收益；汇总可用不等于切片可归因 |
| 一致备份、旧schema/未知列/索引/FK、失败/中断、旧程序接管 | 19/20/21 | 旧执行/账本保全，未知活动执行不迁移，新写入后不恢复旧备份抹账，不兼容路径拒绝 |
| A页过滤/详情/确认/执行、Positions/Risk、四腿/三腿保留 | 13/14/17/18/21 | 正式页面实际浏览器可复查，使用隔离fixture/stub；原型或jsdom不足以单独证明 |

## 标准检查与结果处理

```text
yarn verify
yarn --cwd web build
python3 -m unittest discover -s tests/monitor -v
python3 -m unittest discover -s tests/screening -v
```

root/web依赖分别按frozen-lockfile安装，Node≥22.13、Yarn1.22.22。受影响Python suite另跑；16改变monitor语义，历史/机会筛选改变screening时分别取证。server集成使用app.inject且fake venue/clock、封锁真实HTTP；浏览器环境只提供fixture/stub，不连接运行终端6688或真实交易API。不运行live/test:live/live cleanup，不用实盘成交证明本功能。

默认全量失败时保存失败日志，单跑/降低并发仅诊断；若需改测试或配置，先查因、正式记录后重跑完整标准门槛。不能把原型阶段4988通过的组合结果冒充新的正式实现全绿。迁移、停用、UI和source支持矩阵是独立证据项，不因verify或build通过而自动合格。

06候选文档阶段的默认verify仍有两项前端失败；08—10实施交接也记录默认全量PairTicket/App设置等UI失败，单独诊断/降低并发通过未替代全量结果，详见[06核查](evidence/delivery-readiness-review.md)及[08](evidence/08-implementation-handoff.md)/[09](evidence/09-implementation-handoff.md)/[10交接](evidence/10-implementation-handoff.md)。08本轮已查明并修复配置就绪竞态，通过默认完整verify/build后resolved，见[最终验收](evidence/08-final-validation.md)；09于2026-10-28通过默认完整verify/build并resolved，见[09最终验收](evidence/09-final-validation.md)；10仍待签收。此前PairTicket超时本轮未复现，耗时贴近5秒的诊断线索仍留21关注。其余票须满足各自依赖及完整验收，不反向等待21 resolved；21在最终正式实现版本重新完成全部门槛后签收。

06最终确认仅使此规格/任务可交接，不把未来矩阵结果填PASS，也不自动认领或实施下一票。
