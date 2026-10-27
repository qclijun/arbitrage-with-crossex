# 工单11实施交接

目标：按[组合与成本契约](../pairs-costs-and-ranking.md)及03到期转taker决定，实现规模相关成本、持有期与回本情景。用户确认接缝（2026-10-28）：纯情景模块＋证据适配；借款/换汇为显式证据输入，未提供即UNKNOWN；不接index/AppDeps/路由/页面（12/13承接）；不解析venue盘口自带时间戳（`at`为读取开始时间，源有效性由12判定）；不从账户推导借款适用性。

## 交付

- `src/core/funding/exact.ts`：十进制字符串→精确有理数，加减乘除与比较不舍入，仅展示时最多18位、四舍五入远离零。
- `src/core/funding/scenario.ts` `estimateFundingScenario`（纯）：两腿相同标的数量；各腿以自身盘口mid定价，按显式`from→to`汇率换到声明共同计价币（同币种才为1，USDT/USDC须有汇率，冲突报价为`fx-unverified`）。逐腿日资金费（short收、long付，按窗口天数平均），`G_day`、借款日成本、`D`、一次性`C`、`H×D−C`及回本四分支（UNKNOWN／D≤0无有限回本／C≤0无需回本／C÷D）。正常路径：maker A＋taker B开仓、两腿taker平仓；转换路径：A未成交全量转taker，标`fullQuantity`，仅参考、非上限。费用按成交价计，盘口冲击相对mid单列一次，不重复扣滑点；taker按全量走簿，深度不足`depth-insufficient`不外推。maker在mid内挂单未成交不计收益（钳为0），maker价穿越对手盘为`maker-price-crosses-book`。已知零费率/返佣保留为已知金额；“不适用”须附依据，否则UNKNOWN。真实费率未知时另给`assumedReference`（`basis:'assumed'`），`unknown`仍列出原因、阻止下单。每条成本附来源、时间、真实/假设及一次性/按日性质；`SCENARIO_ASSUMPTIONS`披露历史均值延续、当前盘口/费用/借款不保证、基差/价格/汇率路径未建模、非实际净利润及转换参考非上限。
- `src/core/funding/cost-evidence.ts`：`feeEvidence`把`/crossex/fee`行（含`special_fee_list`）保留为字符串证据，缺行/格式错/读取失败为UNKNOWN并附VIP0假设参考；`bookEvidence`把已解析盘口还原为十进制字符串，读取失败按类别UNKNOWN；`readCostEvidence`以注入读取器单次并行重读两腿费用与盘口，统一盖读取开始时间，不使用缓存、不重盖时间，单腿读取抛错只令该腿UNKNOWN。

## 验证

`tests/unit/funding-scenario.test.ts`（12）与`tests/unit/funding-cost-evidence.test.ts`（4），离线合成证据（`tests/helpers/funding-cost-fixture.ts`），覆盖验收表：N_short=110/N_long=100得G=0.06、D=2/C=10/H=3回本5天且3天−4、UNKNOWN/零/不适用/返佣区别、VIP0假设、薄盘口、跨报价币缺汇率、持续成本吃掉正差、零/负D、两腿均负、非正C、持有期不足，以及以10排名的窗口总额代入情景后排名/资格不变。tsc通过；默认并发`yarn verify`退出0（root 3335通过、8跳过，web 1711/1711，文件预算通过），`yarn --cwd web build`通过。日志：`/tmp/ticket11-verify2.log`、`/tmp/ticket11-web-build2.log`。无实盘测试。

## 审查

双轴审查（standards/spec）无硬违背。据此修正（先红后绿）：maker价差不计收益、穿越盘口的maker价阻断、盘口读取抛错不丢费用证据；`CostLine`拆分`rate`（费率）与`price`（成交/挂单价）；夹具改为有价差盘口，否则锁定盘口下maker无处挂单。未采纳（判断项）：汇率不自动取倒数（须显式方向，缺即UNKNOWN）；`exact.ts`暂留funding目录；费用行查找未与`estimate/fees.ts`共用（后者转Number）。

## 待办

12须消费本证据做严格10秒/源有效性准入并提供账户借款/换汇证据；13把正常与转换两套情景及假设披露接入A页。
