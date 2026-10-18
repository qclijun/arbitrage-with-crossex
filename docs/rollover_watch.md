任务：Boros 旧仓（10-30 到期）展期决策的逐日盯盘与二次决策点。只读查询，严禁任何交易/执行调用（尤其禁止 /api/boros/roll/execute、/api/boros/pair/execute 及任何下单、撤单、充值、授权接口）。唯一允许的 POST 是 /api/boros/roll/simulate（只做交易所整批预检，不下单、不改状态；用户 2026-10-17 放开），scripts/rollover_watch.py 依赖它。

背景（自包含，不要依赖会话历史）：持仓 0xc70f77072a7dae64ac4997c70dabbca39839cbbc（Boros subaccount 0，根地址）。旧腿：market 196 Hyperliquid ETH 30 Oct 2026 SHORT 3.9888313 ETH（锁定 entryApr 7.7667%）+ market 198 OKX ETHUSDT 30 Oct 2026 LONG 3.9888313 ETH（锁定 entryApr 3.1072%），锁定费率差 L = 4.6595%，到期 unix 1793318400。拟滚入的新腿：market 209 Hyperliquid ETH 27 Nov 2026（SHORT，收 execShortApr）+ market 213 OKX ETHUSDT 27 Nov 2026（LONG，付 execLongApr）。新腿到期以 API 返回值为准，预期 1795737600（= 旧到期 + 28 天，用于校验，不符即报 WARN）。已有 12-25 组（128/129）不动。

执行门禁 G（FOK/原子成交语义针对当前部署的核验）：**状态 VERIFIED（2026-10-17，只读核验，证据见下）**。复核脚本 `scripts/verify_roll_fok.ts`（只取 calldata，不签名、不提交；无 key、无 /send-txs 调用）。

- 构建器：`calldata-builder/agent/roll-over` 对 198→213、196→209 返回 4 条 `placeSingleOrder`（selector `0x8c69996c`），解码后每条 `tif = 2`。用 IOC(1)/FOK(2) 差分构建 `place-order`，唯一稳定变化的 calldata word 是 slot 4，其余 slot（含随构建漂移的 slot 12）不随 TI 变化。
- 部署合约：Arbitrum 42161 Router 代理 `0x8080…DEf6` → 实现 `0x9382e315bb6b8ed94d74a3a32f7781c9d6d71df8`（Sourcify exact_match，solc 0.8.28）；其 `RouterFacetLib` 把 `0x8c69996c` 路由到 `tradeModule`，签名 `placeSingleOrder(((bool,uint24,uint24,uint8,uint8,uint256,int16),bool,uint64,bool,uint256,bool,int128))` 与 calldata 布局一致。MarketHub `0x1080…ADaD` → `MarketHubEntry`，market 198 代理 → 实现 `0x1e4157d8…63c0`，`CoreOrderUtils._shouldPlaceOnBook` 对 FOK 执行 `require(hasMatchedAll, MarketOrderFOKNotFilled)`，即未全成交即 revert。
- 限额绑定：`closeRate`/`openRate` 正确映射到 calldata 的 `tick` 边界（0.0301→297、0.0400→392、0.0200→198，tick 步长 1e-4 APR），不是按 mid±slippage 重算。
- 实盘补验（2026-10-18）：用户执行的 1.98 ETH 小批已核对链上成功回执、同一交易四条成交事件、每腿等量及新旧仓位守恒，证实本部署该次提交成功。原始回执/费用快照与核算只保存在本机 `data/risk-monitor/rollover-audit-2026-10-18/`，不提交仓库。单次成功不保证后续报价/深度或收益；`--receipt-success` 仍是人工核验声明，不是脚本自行推断或执行授权。

三条路径：
- A：到期前一次性原子展期全部 3.9888313 ETH（/boros/roll/execute，退出侧容忍 0.5%；默认 0.25% 下 OKX 10-30 成交量为 0）。
- A′：**按实际深度逐批原子展期**。首次以满足最小交易量、成本及风险预算的可核查小批验证真实 receipt；随后每批重新报价、整批预检、提交一次、确认 receipt/事件并逐 market 对账，再决定下一批。每批四腿同量 q，FOK 的“全额”针对本批 q，不要求总仓位一次成交。全量深度不足、小批预检通过时优先保留 A′ 候选；不固定用总量的 5%–10%，也不把一次小批成功推断为后续批次一定可成交。**本文及监控仅产生预检候选，不授予交易执行权限。**
- B：旧腿持有到 10-30 结算，再单独开 209/213。按 docs/ROLLOVER-PLAN.zh-CN.md §1，到期后单独开新仓须另审完整方案。**B 未排除（用户 2026-10-17 决定）；审批稿已起草：docs/ROLLOVER-B-PLAN.zh-CN.md（草稿，未获批，§4 预算未填）**。获批前 B 只能比较，不能执行。

符号（v3）：YR=31536000；N = 本批 q × ETH 美元价；t_old=(1793318400−now)/YR；t_new=(新腿到期−now)/YR；t_reopen=t_new−t_old。所有 APR 都用小数。

步骤：
1. 读 /home/jerel/workspace/GitHub/arbitrage-with-crossex/api-token 得到 token（不要输出 token）。本地终端请求带 -H "x-arb-token: <token>"；官方公开市场请求严禁携带本地 token。
   GET http://localhost:6688/api/asset-view/0xc70f77072a7dae64ac4997c70dabbca39839cbbc，取以下数据：
   - ETH 美元价。
   - 196/198 的数量与 entryApr。以完整、同账户/子账户、未过期仓位核对进度：196/198 旧腿数量须相等，记 R；209/213 新腿数量须相等，记 T（完整快照中两腿均不存在才记 0）；逐平台须有 R + T = 3.9888313，方向/平台/标的/抵押池/到期须匹配。旧腿 entryApr 须与上述锁定值相差不超过 0.01%（1bp）；通过校验后以本次完整仓位的精确 entryApr 相减计算 L，原列值仅作四舍五入后的身份校验基线。0 < R < 原总量且 T > 0 是合法部分展期，不应报数量异常；单腿缺失、旧新不平衡或总量不守恒则 WARN，停止给建议并先查执行状态。12-25 组不纳入本计划进度。
   - 只有完整快照证明两条旧腿均为 0，且新腿为全量或两条新腿也均为 0，才转结束分支（分别记录 ROLLED/EXITED）。单腿缺失、数据缺失或部分覆盖不等于结束。仓位守恒不代替真实 receipt。
2. **先确定报价批量，再计算经济性**：
   - 用 R 调用 `POST /api/boros/roll/simulate`；四腿始终同量，退出容忍 0.005、新开容忍 0.0025，禁止监控自动放宽容忍。
   - 全量失败时，从四腿各自 `sizeWithinTolerance` 的最小值与 R 中取上界，向下取到 3 位小数（共享 profile 的 probeDecimals）作为探测网格；若等于已失败全量则先减半，随后失败减半，最多 6 次。探测网格不是平台 lot size，更不是已批准试批量。低于 $10/腿不再探测；没有价格、深度、完整四腿或完整 venue 结果时保持 UNKNOWN。只报告“本轮已验证候选 q”，不声称找到全局最大批量或证明所有批量均不可行。
   - 本批预检通过必须同时满足：新鲜且同账户的四腿同规模/方向/期限结果、venue=Succeed、四腿 filled 且 matchedSize=q、无 blockers、各腿实际容忍内深度覆盖 q、各腿 |exec−mid| 不超过该腿配置容忍、阶段保证金 need/afterExit/after/shortfall 完整且无缺口、gas 余额至少 $2。gas 余额不是本批 gas 成本。
   - 默认报价 q 为本轮已验证候选；没有候选时只报价 R 作参考，禁止给出可执行结论。`--batch-size q` 可只预检指定试批/候选；未通过不得静默改成其他批量。采样持续约两分钟，之后重读仓位并刷新全量和所选批量预检；仓位变化或预检失效则停止建议，不沿用旧证据。
   - 按 q 的实际名义金额报价（以下 N 改为 q × ETH 美元价；R/T 另记，不把已滚部分重复计入）：GET http://localhost:6688/api/opportunities?borosEntry=market&exitMode=roll&notionalUsd=<round(N)>，在 ETH 组取：
   - 新腿：209.execShortApr、213.execLongApr、两者的到期时间。
   - 旧腿退出价：196.execLongApr（平空 = 买入）、198.execShortApr（平多 = 卖出）。
   - 各腿 mid/mark APR 与 taker 费率（takerDragApr 或 takerFeeRate，按接口实际字段）。
   间隔约 1 分钟取 3 次，用中位数，同时记录 min/max。任一次请求失败或字段缺失时，相应聚合量记为 UNKNOWN，不以剩余样本中位数代替完整三采样；E 缺失时不计算 A。普通利率市场 midApr=0 表示缺失，不回退 mark，合法负利率仍有效。必要报价或证据范围不完整、采样少于3次或间隔不足60秒时，仅作诊断，当日不给行动建议，记录不得作为有效趋势基线。
3. 计算：
   - 退出差 E = 196.execLongApr − 198.execShortApr。
   - 新腿执行差 S = 209.execShortApr − 213.execLongApr。
   - 滑点检查按本批：退出两腿 |exec−mid| ≤ 0.005，新开两腿 ≤ 0.0025，并与各腿实际 `slippageApr` 一致。全量滑点/深度失败只否定全量，不否定另行验证的小批 A′。出口最大偏离记 X_max。
   - **裸 APR**：E、S、L 都是原始利率，`execLongApr/execShortApr` 是盘口执行 APR，**不包含结算费**。`pair.simulation.estSpreadApr` 才已减结算费，二者不能混用或重复扣费。
   - **交易费计时**：仅 GET `https://api-boros.pendle.finance/apis/v1/markets/by-ids?marketIds=196,198,209,213`。验证四个市场身份、tokenId、maturity、平台、完整分页、syncStatus（≤120秒）、原始 takerFee/settleFeeRate、paymentPeriod 及 `data.timeToMaturity`。本次报价每腿预计 feeWei = ceil(q × takerFeeRaw × timeToMaturity / YR)，逐腿向上取整至 wei，再合计并估值。timeToMaturity 随各市场结算时钟阶梯变化，**不是 maturity−请求时刻**；HL 每小时、OKX 每8小时。缺失/过期/不一致即 UNKNOWN，禁止以固定回退费率给出收益建议。账本保存逐腿预计费用、配置和计时；实付最终仍以成交事件 fee 为准。
   - fee_A 为当前四腿预计交易费之和；fee_B = 新两腿当前年化 taker 费率之和 × t_reopen × N，**只是未来 B 费率不变且到期边界重开的情景估计**，非未来实付承诺。旧腿到期结算不收 taker。
   - **结算费显式计入**：令 c_old/c_new 为对应两腿年化 settleFeeRate 之和。settlement_A = c_new × t_new × N；settlement_B = (c_old × t_old + c_new × t_reopen) × N。两边各减一次；当前四腿每腿年化0.1%时，两方案相同评估终点的结算费近似相等，但仍影响绝对收益，不得遗漏。
   - A_usd = (L−E) × t_old × N + S × t_new × N − fee_A − settlement_A。
   - B_cash(S_r) = L × t_old × N + S_r × t_reopen × N − fee_B − settlement_B；S_r 是10-30实际重开原始执行差，未知。
   - **主观风险折价独立列示**：R_B = r_B × t_reopen × N，默认 r_B=0.005，可用 `--b-risk-premium-apr` 修改。B_risk_adjusted = B_cash − R_B。R_B 不是已支付费用，也没有被证明是未来必然损失；资金费空档>300秒另报 CRITICAL，不用 R_B 代替告警。
   - **两条打平线**：S_r_star_cash = (A_usd − L × t_old × N + fee_B + settlement_B)/(t_reopen × N)；风险调整 S_r_star = S_r_star_cash + r_B。纯现金与风险调整的倾向必须同时报告，不能把风险调整优势称为确定多赚。
   - 保守预期 S_cons = 最近 3 个自然日（含今日）、同计划且 **quote_size_eth=q** 的 v=3 记录 S 最小值；v1/v2保留原账，不混入v3趋势；v3必须明确同计划与同q。
   - 纯现金 M_cash = S_cons − S_r_star_cash；风险调整 M = S_cons − S_r_star。上述 A、B、S_r*、M 都只对应本批 q；已经滚入的新仓是共同持仓，不能再算作待滚收益。不同 q 的变化列/历史不得混比。
   - A′ 跨批总收益/总费用不能靠“本批 × 批数”推算：每批 q_i、t_i、执行价分别计算 A_i，再减尚未计入的该批 gas/中继费用，并核对实际累计成本和剩余预算。未来批次报价与盘口补充未知，总计划收益保持 UNKNOWN。`--batch-overhead-usd` 只记录人工核验的A侧额外净成本（与本次模型的共同项/已扣项剔重后）；缺失时 `A_after_batch_overhead_usd=UNKNOWN`，不把 gas 余额当成本。成本预算、收入、最迟启动/退出截止、值守和上一批 receipt 未核验时，实盘准入仍为 UNKNOWN。
   - 报价持平情景（非预测）：显式输出 B_cash_ref_usd、B_risk_adjusted_ref_usd、A_minus_B_cash_ref_usd、A_minus_B_risk_adjusted_ref_usd。B_minus_A_ref_usd 在 v3 为**纯现金** B−A；两种结果可以异号。它们不是重开报价预测，也不单独替代打平线判断。
4. 追加一行 JSON 到 /home/jerel/workspace/GitHub/arbitrage-with-crossex/data/risk-monitor/rollover-watch.jsonl（不存在则创建）。字段：v=3、ts、now_unix、eth_usd、N_usd、t_old_yr、t_new_yr、t_reopen_yr、L、E、S（含 min/max）、四腿 exec/mid、X_max、f_x、f_n、fee_source、fee_A、fee_B、R_B、A_usd、S_r_star、S_cons、M、B_minus_A_ref_usd、gate_G、warns，以及 quote_size_eth、remaining_eth、rolled_eth、progress_state、full_batch_ready、batch_ready、batch_size_eth、batch_probes、simulation_observed_at、batch_overhead_usd、A_after_batch_overhead_usd、execution_pending、execution_admission。
   新增字段：market_fee_terms、fee_A_eth_by_market、fee_clock_seconds、settlement_A_usd、settlement_B_usd、S_r_star_cash、M_cash、B_cash_ref_usd、B_risk_adjusted_ref_usd、A_minus_B_cash_ref_usd、A_minus_B_risk_adjusted_ref_usd、risk_premium_apr、profit_scope。采样完整性记录 sample_count（成功次数）、sample_expected_count（计划次数）、sample_complete、sample_interval_seconds；有效历史须明确 sample_complete=true、成功次数等于计划次数且至少3次、间隔至少60秒。先读历史；只比较v3同q完整记录，v1/v2及完整性未确证的旧记录保留但不作为当前收益/趋势证据。
5. 向 BOSS 输出中文汇报，结论先行：结论一行 + 关键数字表（S、E、S_r*、S_cons、M 及较昨日变化，A_usd，X_max，G 状态）+ 当日建议。终端不可达时报 UNKNOWN，不编造数据，留待下轮。
   当日**风险调整**倾向规则（另报纯现金倾向和假设；G 已通过；经济性倾向、技术预检候选、实际执行准入须分开显示）：
   - M ≥ +0.002：倾向 B（持有到期再重开；B 执行前须先有获批方案）。
   - M < 0：倾向滚。
   - 两者之间：中性，继续盯盘。
   - 倾向滚时，先按规模判定：全量预检失败但小批 q 通过 → A′ 候选；没有已验证小批 → UNKNOWN，不能以全量失败直接宣称 A′ 不可行。即使已有成功 receipt、X_max ≤ 0.004，只要全量未通过，也不能选 A。
   - 全量通过时，再考虑首批回执验证：尚无真实成功 receipt 或 X_max > 0.004 → A′ 试批候选；只有全量通过、已有真实成功 receipt 且 X_max ≤ 0.004，才有 A 候选。`--receipt-success` 是人工核验声明，不是监控自行推断或执行授权。
   - 每批确认 receipt/事件和逐平台 R+T=原总量后，重新运行并重算候选。未知/pending 交易禁止重发和新批次；可用 `--execution-pending` 显式阻断。预算或时间门未填不能启动，残余仓位到已批准决策截止仍无法滚入时按 ROLLOVER-PLAN 的退出分支处理。
6. 决策点规则：
   - 日期 ≥ 2026-10-25 时进入“二次决策点”，给出明确的二选一建议（滚[A 或 A′] vs B），附完整依据：A/B 已知现金流项和缺失成本（缺失时不声称完整净收益）、剩余天数、滑点检查结果、逐腿同平台约束、到期日值守，以及资金费空档 >300 秒即 CRITICAL 的提示。
   - 可执行性约束优先于经济性：G 已通过；B 方案未获批 → B 不可执行；A/A′ 只有对应规模的技术预检通过才是候选，实盘准入须另核验。在二次决策点/已批准截止，若无已验证展期候选或实际准入仍未核验，而 B 也未获批，报 CRITICAL，转 ROLLOVER-PLAN 的退出方案，并请求人工决策。
   - 日期 ≥ 2026-10-29（Asia/Taipei），或旧腿已不在（已执行展期或退出）时，在汇报中说明盯盘结束，不再继续。运行中跨过该午夜也须结束：等待最多到截止时刻，截止后不再发起报价、整批预检或公共费率采集；仅日期截止不能证明已展期或已退出。

汇报保持精炼：结论一行 + 关键数字表 + 当日建议。

Risk 页面对应：`rollover.full_batch_ready` 单独显示 R 的全量状态；`rollover.atomic_batch_ready`、`depth_coverage_ratio` 和阶段保证金属于所选候选 q；`rollover.roll_path=A_PRIME` 表示小批技术候选；FULL_PREVIEW 仅表示全量预检通过，监控不自动收集/认证实际receipt，仍不能据此自动建议 A。`rollover.execution_admission=UNKNOWN` 单列实盘准入缺口，非执行许可。remaining_eth/rolled_eth 显示逐腿进度。完整仓位证明已滚完/已退出时预检指标为 NA；资料缺失/异常保持 UNKNOWN。每日账本只展示与当前 R、q 同口径的记录，过期标为历史；后台监控与页面共用同一判断。


v3 费用与实盘核对纪律：
- 固定现金流和未来结算费按连续剩余年数估算；逐市场离散结算边界、浮动现金流及已实现PnL以事件账本核对，预估不保证逐wei复现实盘。逐腿交易费则以当前市场fee clock计算并按协议取整，实付最终取成交事件。
- `A_usd` 仅扣当前模型中的交易费、预计结算费；不是完整到手净收益。首次进场费、gas预算、借款利息、永续基差和后续退出等仍须独立核验；缺项时完整净收益为 UNKNOWN。未来预计结算费不得写成实付。
- 首次进入新市场的抵押品扣费，以 `EnterMarket` 事件为准，不以文档示例硬编码金额。新市场已经进入后是否再次收费仍核对 entered 状态；不能把首批费用乘批数。
- Gas预算分账：期末=期初+topUpAmount−gasFee。进入费对应的Gas信用不是现金利润；进入扣款及其覆盖的预算消耗不能重复作为现金支出；网络回执Gas与代发账本Gas也不能再加一次。预算余额不等于费用。
- 原有持仓的lazy settlement可能在展期交易中一起落账，且含12-25或其他市场；按market和计息窗口核对，单列历史累积结算费，不全分摊给本批。平旧实现PnL已净扣对应交易费，不能再扣一次；它不是全策略净利润。
- 实盘验收须同时核对 receipt成功、txHash一致的四腿成交量与方向、每market旧/新仓位、逐腿实付fee及配置、进入费与Gas流水；仓位守恒或模拟Succeed均不能代替真实回执。
- 回放本笔只使用私有原始证据，不拿实时剩余仓位报价冒充已成交批次；比较 A′/B 时使用相同 q、统一估值价格和同一结束日。未来B报价/费率未知。当前价差持平只是一种情景，非预测；风险折价主导的倾向应明确说明。
- Risk 仅消费v3同R/q、同账户和新鲜三采样记录；v2收益口径已作废，保持历史存档。技术预检仍独立来自实时四腿模拟，不受每日收益版本替代。
