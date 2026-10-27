本阶段按用户调用wayfinder完成永续两腿机会页初始建图与规格草案，不实现产品、不交易、不启动服务、不提交推送。用户已确认升级Funding Spreads独立入口、保留四腿/三腿页；全CrossEx符合条件组合双向扫描，30天排序和7天对照，可选五窗口；人工maker＋hedge，首版仅沿用ETH/BTC/HYPE及同计量单位执行。用户已确认Q7：默认30天、最短7天，仅所选窗口完整才参与排名和进入下单；较长窗口不足不影响完整短窗口。已核实只读现页/当前feed与既有两腿执行可复用，但全历史服务、全组合枚举、成本/预检、共享净仓策略归属及Risk适用范围待定。map.md为入口、spec.md明确draft，issues下六票均open未认领未解决，按依赖首选“历史证据与机会资格”。证据在evidence；各文件链接、依赖和5000token限制检查通过。GLOSSARY补充两条术语，无交易代码改动。Q7答案已同步地图、规格和历史证据票的评论；后续按wayfinder一次认领并解决一张决策票，不把草案冒充实施就绪。

## 文档提交阶段

用户要求将当前规格和相关工单提交到新分支。已从dev建立隔离工作区/tmp/arbitrage-perp-funding-opportunities-docs，分支docs/perp-funding-opportunities；提交范围限定为本功能地图、规格草案、六张决策工单、两份源码证据、交接及GLOSSARY术语。当前研究工作区保持原状，不包含研究实现、data账户记录、凭据或其他功能变更。Q7已确认为所选窗口完整才参与该窗口排名及进入下单，较长窗口缺失不影响完整短窗口。提交前检查Markdown链接、工单依赖、Q7一致性、文件token预算和差异空白；提交信息为docs: plan perpetual funding opportunities。规划仍是draft，六票open；后续按wayfinder解决首张历史证据与资格决策，不把本次文档提交解释成产品已实现。无推送、服务操作或实盘验证。

## 工单01完成交接

用户已全部确认Q1—Q4，工单01「历史证据与机会资格」已resolved，答案同步history-and-eligibility.md、规格和地图。规则为UTC整点共同截止、逐腿逐窗口严格覆盖、局部失败隔离及后台15分钟刷新，stale仅观察。分支docs/perp-funding-opportunities，提交基准ce42320；本轮提交范围仅8份文档。07可开展历史源研究，08/09预拆且由06阻塞；下一张决策票为02，整体规格仍draft。15份文档的37个本地链接、9票依赖无环、差异空白及8份暂存文件token检查通过；全量verify和web build因未安装依赖、缺tsc未运行成功。双轴审查无规则缺陷，已修正审查指出的交接过时。证据：/tmp/perp01-doc-validation.txt、perp01-standards-review.md、perp01-spec-review.md及perp01-verify.log、perp01-web-build.log（均在/tmp）。按用户要求提交当前分支，不推送；未改产品代码、启动服务或交易。

## 工单02完成交接

用户两轮确认Q1—Q7，工单02已resolved，契约在pairs-costs-and-ranking.md，规格/地图已同步。全有向组合保留零/负/反向；真实成本UNKNOWN不影响历史分数但阻止下单。maker＋hedge开仓、双taker平仓仅作情景，回本按逐腿名义金额与净日收入计算，未来基差/汇率风险未覆盖。分支docs/perp-funding-opportunities，基准90839e2；本轮仅7份文档。10/11受06阻塞，11另等待03；下一决策票03，整体规格仍draft。按冻结锁文件安装依赖；18份文档/50个本地链接、11票无环、预算/差异空白检查通过。yarn verify通过4988项、跳过8项，web build通过；双轴审查无未解决发现。证据均在/tmp：perp02-verify.log、perp02-web-build.log、perp02-doc-validation.txt、perp02-standards-review.md、perp02-spec-review.md。按要求提交当前分支，不推送；无产品代码、服务或交易操作。

## 工单03完成交接

用户两轮确认Q1—Q7，03已resolved；契约preflight-and-execution.md及规格/地图、02成本契约、11任务同步。Q7保留到期转taker：默认300秒、30–3600秒，初次授权并展示正常/转换费用，不采用到期停止。精确预填、10秒/800ms确认、服务端重验和持久幂等均为待实现要求，IOC无用户硬价格上限。分支docs/perp-funding-opportunities，基准9dbab22；仅11份文档，12—14受06阻塞，下一决策04，整体draft。事实证据evidence/preflight-review.md：图Tier2、26路径best-effort覆盖；不能把现有fail-open、杠杆route直写当保障。23份文档/73链接、14票无环、预算/差异空白通过；yarn verify通过4988项/跳过8项，web build通过，双轴审查0项发现。日志及审查均在/tmp/perp03-*。按要求提交本分支、不推送；无产品代码、服务或交易操作。

## 工单04决策闭合

用户两轮确认七项决定，04已resolved。ownership-and-risk.md及risk-applicability.md规定实际成交切片、指定量加减、可证明才同向共享、差异UNKNOWN、逐数量Risk及当前认领，不倒填历史。分支docs/perp-funding-opportunities，基准1c7cb74；本轮14份文档。15—17等待06，12依赖15/16；下一决策票05，整体仍draft。事实见evidence/ownership-review.md和risk-applicability-review.md，含HYPE、旧basis/rollover及监控限制。30文档104链接、17票无环、预算及差异检查通过；双轴审查各0项。首次verify有1项弹窗等待失败，单文件2项通过，完整verify复跑4988项通过/8跳过，web build通过；证据均在/tmp/perp04-*（含verify.log、web-focused-retry.log、verify-retry.log及双轴报告）。提交当前分支、不推送；无产品代码、迁移、报警或交易改动。

## 工单05原型交付待验收

目标为页面、详情与确认原型；基准f0a10ef，当前分支提交可丢弃讨论资产。05已claimed，A排名工作台/B研究画布/C分步确认可交互；入口page-prototype.md，运行yarn --cwd web prototype:funding，仅127.0.0.1:8795，固定fixture、不接账户/API、不持久化。Chrome已检验长按、部分成交/UNKNOWN查询、stale、缺失证据、重报价、编辑失效及maker限价绑定，截图/记录见evidence/prototype-*。Standards无发现，Spec两项P2修复后未解决0。类型/build通过；root3278通过8跳过，web降低并发全量1710通过。默认verify仍有两项前端超时，单独复跑26通过；原失败与复核日志保留/tmp/perp05-*，不称默认门禁全绿。32文档116链接及17票无环验证通过。待用户选择/组合布局并验收；05保持claimed，06/17阻塞，spec仍draft，不升级真实页面。

## 工单05用户验收闭合

2026-10-27用户对原型7b74406明确答复“A排名工作台，交互可验收”，无修改要求；本阶段仅记录验收、关闭05并同步规格/地图/依赖，保留原交付记录。确定A左侧有向排名表＋右侧连续详情，历史/成本/预览确认/执行残余及归属反馈按展示交互验收；B/C仅比较资产，不将模拟执行或页面验收视为生产交付。05 Answer、page-prototype.md及evidence/prototype-review.md保存依据。本轮只改文档，复核本地链接、17票依赖无环及文本预算，复用原型阶段类型/build和离线套件结果并保留默认并发超时记录。01—05现均resolved，06为下一张开放无阻塞决策票，未自动认领；17仍等06/15/16，08—17不得实施，spec继续draft。当前分支提交验收记录，不推送、不部署、不实盘。
