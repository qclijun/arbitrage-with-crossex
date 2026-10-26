本阶段按用户调用wayfinder完成永续两腿机会页初始建图与规格草案，不实现产品、不交易、不启动服务、不提交推送。用户已确认升级Funding Spreads独立入口、保留四腿/三腿页；全CrossEx符合条件组合双向扫描，30天排序和7天对照，可选五窗口；人工maker＋hedge，首版仅沿用ETH/BTC/HYPE及同计量单位执行。用户已确认Q7：默认30天、最短7天，仅所选窗口完整才参与排名和进入下单；较长窗口不足不影响完整短窗口。已核实只读现页/当前feed与既有两腿执行可复用，但全历史服务、全组合枚举、成本/预检、共享净仓策略归属及Risk适用范围待定。map.md为入口、spec.md明确draft，issues下六票均open未认领未解决，按依赖首选“历史证据与机会资格”。证据在evidence；各文件链接、依赖和5000token限制检查通过。GLOSSARY补充两条术语，无交易代码改动。Q7答案已同步地图、规格和历史证据票的评论；后续按wayfinder一次认领并解决一张决策票，不把草案冒充实施就绪。

## 文档提交阶段

用户要求将当前规格和相关工单提交到新分支。已从dev建立隔离工作区/tmp/arbitrage-perp-funding-opportunities-docs，分支docs/perp-funding-opportunities；提交范围限定为本功能地图、规格草案、六张决策工单、两份源码证据、交接及GLOSSARY术语。当前研究工作区保持原状，不包含研究实现、data账户记录、凭据或其他功能变更。Q7已确认为所选窗口完整才参与该窗口排名及进入下单，较长窗口缺失不影响完整短窗口。提交前检查Markdown链接、工单依赖、Q7一致性、文件token预算和差异空白；提交信息为docs: plan perpetual funding opportunities。规划仍是draft，六票open；后续按wayfinder解决首张历史证据与资格决策，不把本次文档提交解释成产品已实现。无推送、服务操作或实盘验证。

## 工单01完成交接

用户已全部确认Q1—Q4，工单01「历史证据与机会资格」已resolved，答案同步history-and-eligibility.md、规格和地图。规则为UTC整点共同截止、逐腿逐窗口严格覆盖、局部失败隔离及后台15分钟刷新，stale仅观察。分支docs/perp-funding-opportunities，提交基准ce42320；本轮提交范围仅8份文档。07可开展历史源研究，08/09预拆且由06阻塞；下一张决策票为02，整体规格仍draft。15份文档的37个本地链接、9票依赖无环、差异空白及8份暂存文件token检查通过；全量verify和web build因未安装依赖、缺tsc未运行成功。双轴审查无规则缺陷，已修正审查指出的交接过时。证据：/tmp/perp01-doc-validation.txt、perp01-standards-review.md、perp01-spec-review.md及perp01-verify.log、perp01-web-build.log（均在/tmp）。按用户要求提交当前分支，不推送；未改产品代码、启动服务或交易。
