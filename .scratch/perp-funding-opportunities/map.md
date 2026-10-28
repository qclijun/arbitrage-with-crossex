# 永续两腿机会页：从浮动利差观察到人工确认开仓

Label: wayfinder:map
Status: open
Updated: 2026-10-27 Asia/Taipei

## Destination

形成可实施的“永续两腿机会页”规格与工单：升级现有 Funding Spreads 独立入口，从历史资金费差筛选到人工确认两腿永续开仓；数据证据、成本、执行、持仓归属及风险边界完整，关键决策解决后才进入实现。

## Notes

- 用户已确认本轮先完成规格/工单，未授权本轮实现产品；按 wayfinder 绘图。本轮不手工关闭决策票，`spec.md` 是记录已确认约束的规格草案，不是 ready-for-agent 的实现契约。
- 用户确认：扫描 CrossEx 支持且有完整历史资金费数据的全部币种/场所组合，双向比较；不局限ETH或Binance/HL。
- 用户确认：升级现有 Funding Spreads 页；保留现有四腿/三腿机会页。
- 用户确认：默认30天历史净资金费差排序，7天对照，可选7/30/90/180/365天，当前一期另列；历史年化不是锁定收益。
- 用户确认：逐笔填写规模/杠杆并确认，用现有maker＋hedge；首版无自动开平仓或资金费反转自动换向。
- 用户确认：扫描全市场，执行先沿用ETH/BTC/HYPE及同计量单位两腿；其他仅观察并显示具体阻止原因，不扩大白名单、不做跨倍数合约换算。
- 用户确认Q7：历史完整性按当前所选窗口判断，默认30天、最短7天；所选窗口完整才参与该窗口排名并进入下单。更长窗口不足不影响完整短窗口，不强求一年。窗口不足的组合保留观察，显示UNKNOWN及缺失原因。
- 采用wayfinder、grilling、domain-modeling及codebase-memory。tracker见 `docs/agents/issue-tracker.md`；决策工单仅用Type/Status，不混用 ready-for-agent。
- 初步规格：[永续两腿机会页规格草案](spec.md)；已核实输入：[源代码边界](evidence/source-review.md)、[执行复用](evidence/execution-reuse.md)。本轮无需要外部知识才能创建的research票；场所新增历史能力等需求出现后再单独创建。
- 每轮按编号选择open且依赖全部resolved、未claimed的议题；先claimed，答案追加Answer，再resolved并在本地图索引。不能把图中方案建议当作用户决定。

## Decisions so far

- 2026-10-27：[07生产历史源研究](issues/07-history-source-research.md)已resolved；[八场所证据](evidence/history-source-research.md)确认有历史来源但逐合约周期/上市/完整性仍多为UNKNOWN，OKX普通端点仅近三个月。09须实测分页、延迟和预算；08/09仍受06准入阻塞。

<!-- 本轮只建图，已确认用户约束放Notes；后续关闭决策票时这里只追加标题链接与一句结论。 -->

- 2026-10-27：[01历史证据与资格](issues/01-history-and-eligibility.md)已resolved，用户全部确认Q1—Q4；共同UTC整点、严格逐腿逐窗口覆盖、局部失败隔离、后台15分钟刷新及stale禁止排名/下单，详见[契约](history-and-eligibility.md)。账户费率未知不影响历史排名但独立阻止下单。02解除01依赖。
- 后续分票：[07生产历史源研究](issues/07-history-source-research.md)核查真实能力；[08证据契约与资格](issues/08-history-contract-and-eligibility.md)、[09后台采集与缓存](issues/09-history-collection-and-cache.md)为预拆实现票，均由06阻塞，当前不可实施。整体规格继续draft，下一张决策票为02。
- 2026-10-27：[02组合、成本与历史排名](issues/02-pairs-costs-and-ranking.md)已resolved，用户确认两轮共七项决定；所有有向组合逐条排名，保留零/负/反向结果；费用/换汇证据与历史排名分离，开仓maker＋hedge、平仓双taker作情景，回本按扣持续成本后的净日收入计算。详见[组合与成本契约](pairs-costs-and-ranking.md)，03解除依赖，当前下一张决策票为03。
- 02预拆[10全组合与历史排名](issues/10-directed-pairs-and-ranking.md)、[11成本与回本情景](issues/11-costs-and-payback-scenarios.md)，均由06阻塞，11另等待03；未授权当前实施产品。整体规格仍draft。
- 2026-10-27：[03预填、重报价与执行](issues/03-preflight-and-execution.md)已resolved，用户两轮确认Q1—Q7；精确候选/参数绑定，编辑与证据变化重新确认，10秒预览/800ms长按及服务端严格重验；零负情景保留人工决策，不放宽UNKNOWN/仓位冲突。用户选择保留到期转taker，初次明确授权并估转换费用，不能改成到期停止。详见[执行契约](preflight-and-execution.md)及[当前事实](evidence/preflight-review.md)，下一决策票为04。
- 03预拆[12服务端证据准入](issues/12-preview-evidence-and-admission.md)、[13精确预填与确认](issues/13-exact-prefill-and-confirmation.md)、[14持久提交与恢复](issues/14-durable-submission-and-resume.md)，均等待06；11已补转换成本分支、解除03依赖，仍等06。单writer/幂等/未知证据等既有缺口须实施后才能宣称具备，整体规格继续draft。

- 2026-10-27：[04策略归属与Risk](issues/04-ownership-and-risk.md)已resolved，用户两轮确认Q1—Q7：持久策略切片、实际成交及显式加减量；同向共享须全部相关归属可证明；场外差异UNKNOWN并阻止相关新增风险，金额证据不足不强行归因。Risk仅解除已证明浮动两腿数量的Boros覆盖要求，其它风险保留；旧仓允许凭完整当前证据显式选量从当前时点认领，不回填历史。详见[归属契约](ownership-and-risk.md)、[Risk契约](risk-applicability.md)及[数量账核查](evidence/ownership-review.md)/[Risk链核查](evidence/risk-applicability-review.md)。下一决策票为05。
- 04预拆[15切片与对账](issues/15-strategy-slices-and-reconciliation.md)、[16逐数量Risk](issues/16-slice-risk-applicability.md)、[17当前认领与金额证据](issues/17-current-claims-and-attribution.md)，均等待06；12增加15/16依赖，未有实际归属证据不默认放行。HYPE、旧basis/rollover及独立ETH监控历史限制仍需实施处理，整体规格继续draft。

- 2026-10-27：[05页面/确认原型](issues/05-page-and-confirmation.md)已claimed，[A/B/C原型](page-prototype.md)与截图供用户比较；本轮尚未验收，不能追加为已确认页面决定，也不解除06及17等后续依赖。
- 2026-10-27：用户随后明确选择“A排名工作台，交互可验收”；[05](issues/05-page-and-confirmation.md)已resolved，采用左排名表＋右连续详情，B/C仅保留比较资产，无附加修改要求。01—05全部resolved，[06规格验收与交付准入](issues/06-acceptance-and-rollout.md)解除前置阻塞、保持open；整体规格仍draft，实施票仍等待06。原型验收不等于产品交付或实盘授权。

## Not yet specified

- 2026-10-27：用户要求继续06，本票已claimed；[准入草案](acceptance-and-rollout.md)核对07—17的责任，并提出首轮分阶段交付及当前证据时效问题，尚待答复。兼容/停用/最终集成的事实和实施承接须继续收敛，整体规格仍draft，不解除实现依赖。
- 2026-10-27：06首轮Q1/Q2已确认：先只读交付、人工开仓默认关闭且验收后明确启用；必要当前证据严格10秒，不能重盖缓存时间或延长原预览。第二轮旧入口兼容、迁移回退、停用在途和完整验收已提出，待用户回答；06仍claimed，后续实现依赖不解除。
- 2026-10-27：06-Q3—Q6已全部确认。已补[18正式A页/API](issues/18-funding-page-and-read-api.md)、[19持久准入/旧入口](issues/19-admission-switch-and-legacy-entrypoints.md)、[20版本迁移/回退](issues/20-ledger-schema-and-upgrade-compatibility.md)、[21集成验收/启用准备](issues/21-integrated-readiness-and-enablement.md)，并更新原票依赖；见[实施顺序与验收矩阵](implementation-plan.md)。候选定稿等待最终共同理解确认；06仍claimed，08—21仍阻塞，不自动实施、部署或启用。

- 01已确定历史产品门槛、缓存时效和冷启动UNKNOWN；具体每场所生产历史源、可证明的结算规则与限流预算由07研究，不承诺当前八场所都有全年历史。
- 04已确定持久切片、当前认领和逐数量Risk政策；具体持久化兼容/迁移仍由06准入，15—17实施后才能声称数量账及consumer具备能力。
- 01—05已resolved，06产品决策Q1—Q6已确认；候选规格/分票/矩阵等待用户最终共同理解确认后才关闭06。之后只按真实依赖开放后续任务，21验收完成才可申请人工启用；任何规划resolved不等于实际下单准备度。

## Out of scope

- Boros开仓/平仓/展期改造、自动资金费择时、自动换向或批量无人确认下单。
- 首版扩大执行币种白名单、跨倍数合约数量模型；观察数据可包含这些币种，但必须诚实标注执行不支持。
- 自建第二个执行引擎、修改凭据与API认证、重启/部署运行中终端、实盘试单、提交推送或发布。

## 06最终确认与当前交接

- 2026-10-27：用户明确“我确认是共同理解”，[06](issues/06-acceptance-and-rollout.md)追加Answer并resolved；[规格](spec.md)、[准入契约](acceptance-and-rollout.md)和[实施顺序/验收矩阵](implementation-plan.md)定稿。此前关于候选稿、06 claimed及最终待确认的记录保留为历史，以本结论为当前状态。
- 08—21解除06阻塞，其他真实依赖保留。08/09/10已有实现9ab7724/4fe5f6d/8df73e1，默认verify未全绿，均继续open；09仍依赖08，10补记09缓存依赖并仍依赖08。单跑/降并发只作诊断，21继续承接查因及正式完整复验债；08—10可在各自完整验收满足后先行签收，无对21的反向依赖。
- 01—07已resolved；当前无未解决前置依赖的open票为08、20，未自动认领。生产数据适配/接线与跨票验收未被本次签收替代；人工开仓仍默认关闭，验收后须用户另行明确启用。

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
