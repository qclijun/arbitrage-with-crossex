# 默认原子展期的只读风险监控与指标设计

Status: ready-for-agent
Type: task
Created: 2026-10-07 Asia/Taipei

## Delivery Phases（2026-10-07 更新，优先于下文原始顺序）

用户要求先获取 Boros market 上标的的流动性指标。本规格按两阶段交付；下文原子展期设计保留为第二阶段目标，不是第一阶段的前置条件。

### 第一阶段：逐 market 流动性诊断（02–05）

先核验官方来源和单位，再复用现有市场列表/统计/订单簿适配器与缓存获取当前快照、计算指标并在现有终端页面展示。身份至少包括 venue、交易对/标的、market ID、collateral、到期日；同一标的不同到期/venue 不混合。范围为当前终端市场列表可覆盖的 Boros markets，展示过滤和覆盖信息，不局限账户持仓。

必需指标为市场全量 24h Volume、Notional OI、best bid/ask APR、mid APR、APR Spread、双边可见累计深度及距各自 best 档位 10/25/50 APR bp 的深度。APR 内部 fraction，展示百分点或 bp；深度提供已核验的 YU/抵押资产单位。具体 bid/ask 方向、Spread 公式、成交量口径和换算由 02 的官方证据确定，不按现货经验假定。OI 不是成交量，成交量不是深度，诊断窗口不是交易容忍度。

每个字段携带来源、源时间（未知可空）、采集时间、新鲜度、完整性与原因；部分/截断订单簿不能声称全市场总深度。缺失或不可验证值为 UNKNOWN；完整空盘口可见深度为 0，但缺失盘口不能补零。市场统计与盘口允许不同源时间，必须披露。第一阶段不采用第二阶段 12 秒就绪标准来声称可交易。

用户提供官网截图展示 venue/标的分组、Collateral、Maturity、24h Volume、Notional OI 等，可作为布局和字段对照；截图没有 Spread/深度且源时刻未知，不能当实时证据或 API 契约。保留只读官方现场对照的时刻与舍入说明。

第一阶段交付包含离线 API → 指标 → 页面验收、真实浏览器宽屏/375px 验收及只读副作用检查。不得输出原子展期就绪或保证成交数量。成交历史/Spread 历史/深度持久采样、新收集器/强制刷新、自动告警和交易操作继续排除。

### 第二阶段：计划相关原子展期风险（06–10）

05 验收后按计划身份与权限、四腿有效深度、完整批次模拟与执行准备、Risk 状态/经济性/新鲜度、页面全范围验收依次推进。下文原始指标、规则、测试与只读边界全部保留；市场流动性诊断本身不能替代权限、有效价格范围或完整模拟。

第一阶段来源证据及后续实现口径见 #02 的 [流动性消费契约](research/02-liquidity-contract.md) 与 [官方来源核验](research/02-official-sources.md)。其中 API 单边 OI、bucket APR Spread、best-50 可见深度及未知统计时间须在 #03–05 延续。

所有子票及依赖见 [工作地图](map.md)。01 保留原始验收作为父级总清单，不直接认领实现。

## Problem Statement

交易者希望持续持有现有永续组合，将两条旧 Boros 资金费仓位续接到更晚到期的两个市场。默认 Roll over 是四笔足量成交订单的原子展期，任何一笔深度、价格边界、权限或保证金检查不通过都会阻止整个计划。

目前 Risk 的下一期机会和深度信息不足以解释四笔订单的瓶颈；现有重叠保证金指标也不能直接描述先平旧再开新的原子展期。交易者需要知道：现在能否按计划展期、受阻在哪条腿、数量缺口是多少、距离到期还有多久，以及哪些结论尚无法确认。机会存在、盘口有挂单、永续价格净敞口为零都不能证明原子展期可执行。

## Solution

在现有只读 Risk 页面提供面向具体原子展期计划的风险结果，复用终端账户、持仓、市场、订单簿、展期模拟及查询缓存。监控旧两腿退出与新两腿进入的交易权限、有效深度、滑点、协议价格边界、完整批次模拟及保证金。

页面显示计划规模、候选到期日、当前可执行状态、四笔订单的瓶颈、可展期数量与缺口、证据时间和距旧仓到期时间。技术可执行性与经济性分别展示；只读监控不提交交易、授权、补充 Gas 或更改仓位。

## User Stories

1. As a terminal trader, I want monitoring to use my selected terminal account, wallet and subaccount, so that the report describes the positions I actually hold.
2. As a terminal trader, I want the old funding legs identified by venue, direction, market and quantity, so that unrelated positions do not enter my rollover plan.
3. As a terminal trader, I want the new funding legs matched to the existing perpetual pair, so that rollover preserves the intended funding hedge.
4. As a terminal trader, I want the monitored maturity and quantity displayed, so that every risk result has an explicit plan.
5. As a terminal trader, I want to select a later candidate maturity, so that I can compare executable alternatives.
6. As a terminal trader, I want the full matched position monitored by default, so that a small executable slice does not conceal a larger gap.
7. As a terminal trader, I want a partial rollover quantity clearly distinguished from my remaining old position, so that I know what still needs renewal.
8. As a terminal trader, I want unavailable target markets explained, so that absence of a valid pair is visible.
9. As a terminal trader, I want permission to close each old leg checked separately, so that a visible order book does not imply an executable exit.
10. As a terminal trader, I want permission to open each new leg checked separately, so that an OI cap does not appear as usable liquidity.
11. As a terminal trader, I want every order evaluated on its actual execution side, so that depth is measured against the correct counterparties.
12. As a terminal trader, I want effective depth within my permitted prices, so that distant orders do not inflate coverage.
13. As a terminal trader, I want the worst of all four depth ratios displayed, so that the weakest order determines the plan's liquidity result.
14. As a terminal trader, I want per-order average execution APR and slippage, so that I can identify expensive exits and entries.
15. As a terminal trader, I want protocol rate limits distinguished from my slippage limit, so that I do not attempt an impossible remedy.
16. As a terminal trader, I want the quantity that can currently roll and the unfilled gap displayed, so that I can assess a smaller alternative.
17. As a terminal trader, I want complete batch simulation before a plan is described as executable, so that four independent quotes do not imply aggregate success.
18. As a terminal trader, I want margin assessed after the old legs close and before the new legs open, so that released collateral is accounted for correctly.
19. As a terminal trader, I want required margin, remaining available margin and shortfall displayed in their actual collateral units, so that I can understand funding needs.
20. As a terminal trader, I want unknown margin inputs preserved as unknown, so that missing simulation is not interpreted as zero shortfall.
21. As a terminal trader, I want authorization expiry and account compatibility visible, so that operational preparation can occur before maturity.
22. As a terminal trader, I want prepaid Gas and its replenishment feasibility distinguished from trading margin, so that low Gas does not trigger the wrong remedy.
23. As a terminal trader, I want source ages displayed, so that a historical passing simulation is not presented as current readiness.
24. As a terminal trader, I want missing, stale and incomplete evidence explained, so that UNKNOWN remains actionable.
25. As a terminal trader, I want known blockers displayed even when other evidence is missing, so that an established problem is not hidden by UNKNOWN.
26. As a terminal trader, I want alerts to become more urgent near maturity, so that a temporary blockage is assessed in its time context.
27. As a terminal trader, I want distant-maturity checks paused only with complete evidence, so that missing positions cannot suppress risk.
28. As a terminal trader, I want rollover economics separated from technical feasibility, so that an executable but unprofitable plan is recognizable.
29. As a terminal trader, I want actual execution APR, old exit PnL and applicable costs used in economic comparisons, so that mid prices do not overstate returns.
30. As a terminal trader, I want account changes to clear incompatible evidence, so that results from another wallet are never inherited.
31. As a terminal trader, I want funding gaps evaluated after maturity or switching, so that continuing perpetual funding exposure remains visible.
32. As a terminal trader, I want funding overcoverage distinguished from funding gaps, so that Open only is not described as complete neutral coverage.
33. As a terminal trader, I want switching completion distinguished from settlement completion, so that a successful roll is not mistaken for final cash release.
34. As a terminal trader, I want refreshing Risk to remain read-only, so that monitoring cannot trade or change notification state.
35. As a terminal trader, I want supported alternatives shown without automatically selecting a trade, so that I retain control over renewal decisions.

## Implementation Decisions

### Scope and existing seams

- The primary scope is default Roll over: close old A/B and open later A/B with full-fill requirements in one atomic batch. Open only and ordinary post-maturity entry remain distinct existing workflows.
- Reuse the existing rollover simulation API, pair quote/gate, market and account adapters, Risk measurement conversion, rule catalog and rendered Risk page. Do not introduce a separate collector or start the standalone risk monitor from the page.
- Use one account snapshot for both steps and the venue's full batch simulation for aggregate FOK and margin feasibility. Monitoring calls only read/quote/simulation operations, never calldata submission, signing, execution, approval, transfer or top-up.
- The main acceptance seam is the existing simulation API to Risk conversion to rendered-page boundary, with fixtures replacing external services. The user confirmed this seam on 2026-10-07.
- A plan identity includes root/wallet, supported subaccount, collateral, old and new market IDs, held directions, old/new maturities, target quantity per leg and each step's price tolerance. Evidence cannot be reused across different identities.
- Default target quantity is the actual matched current pair quantity, with any unequal-position residual shown independently. A smaller selected target must not clear the unrolled remainder's risk.
- Reuse current candidate discovery; select a matching later maturity deterministically and show the choice. No valid candidate is a known blockage only after complete market coverage; a failed or filtered listing alone is UNKNOWN.
- Preserve existing historical identity/quantity display exclusions and unrelated risk categories. This feature does not reintroduce them.

### Metrics and evidence contracts

Every measurement carries value, unit, plan scope, source, source observation time, collection time, completeness and reason. Proposed IDs below define semantics; catalog changes must preserve existing metric meanings or explicitly introduce a replacement.

| Metric | Definition / source | Interpretation |
| --- | --- | --- |
| `rollover.plan_valid` | Match old/new venues, underlying, held sides, collateral, distinct valid markets, equal per-leg moved quantity and later target maturity | False blocks the plan; unverifiable mapping is UNKNOWN |
| `rollover.days_to_maturity` | Earliest actual old-leg maturity minus current time | Preserve existing 14-day WARNING and 1-day CRITICAL boundaries |
| `rollover.close_allowed` / `rollover.open_allowed` | Per-market official state and operation-specific permissions, qualified by account exceptions if documented | Any confirmed prohibited operation blocks; unknown/unrecognized mode stays UNKNOWN |
| `rollover.leg_depth_coverage_ratio` | Per-order available quantity inside both user tolerance and protocol executable bounds divided by that order's target quantity | Below 1 blocks full target; keep ratios above 1 to reveal reserve depth |
| `rollover.atomic_depth_coverage_ratio` | Minimum effective coverage across exit A/B and entry A/B | Four-order metric; do not silently repurpose an existing next-entry-only metric |
| `rollover.book_capacity` | Maximum common moved quantity supported by all four effective books | An order-book estimate, not a claim that margin permits this quantity |
| `rollover.executable_quantity` / `rollover.quantity_shortfall` | Quantity proven by a valid whole-batch simulation and target minus that quantity | Never claim a maximum from one successful simulation; use a bounded validated search if needed, otherwise show confirmed quantity/lower bound |
| `rollover.leg_exec_apr` / `rollover.leg_slippage_apr` | Per-order book walk at target quantity, average execution APR and adverse deviation from the displayed reference | APR fractions internally; percentage points in UI; disclose partial-fill estimates |
| `rollover.rate_bound_headroom_apr` | Per-order distance of submitted rate limit to the relevant official allowed boundary, with limit validity checked independently of average fill | Negative means invalid limit; zero has no boundary reserve |
| `rollover.batch_simulation_status` | Fresh full simulation: pass, refused, unavailable; retain per-order reasons and evidence coverage | A pass is a snapshot estimate, not a future execution guarantee |
| `rollover.required_margin` / `rollover.available_after_exit` / `rollover.available_after_roll` / `rollover.margin_shortfall` | Venue full-batch assessment of sequential close then open, in collateral units | Confirmed shortfall blocks; missing fields remain null/UNKNOWN, never default zero |
| `rollover.agent_valid` / `rollover.agent_expiry_seconds` | Existing approval evidence, revocation status if supported, and remaining validity | Expired/revoked blocks; failed verification is UNKNOWN |
| `rollover.account_execution_ready` | Existing configured signing-account match, compatible margin mode and service readiness exposed as redacted read-only capability metadata | Wrong account/mode or unavailable executor blocks; never expose keys |
| `rollover.gas_ready` | Prepaid Gas plus existing automatic top-up source and simulated feasibility | Low Gas alone is a notice; confirmed inability to fund required Gas blocks |
| `rollover.evidence_age_seconds` | Ages of each required source and full-batch simulation | Age is measured from source time, not browser receipt time |
| `rollover.next_net_apr` / `rollover.cost_breakdown` | Existing actual-size next quote and economic comparison including old exit PnL, applicable fees, slippage and execution costs | Preserve notional APR versus capital APR units; economic failure is distinct from technical blockage |
| `rollover.uncovered_funding_quantity` / `rollover.uncovered_funding_seconds` | Actual perpetual exposure lacking an effective matched funding leg by source, direction and quantity | Reuse existing coverage evidence; no fabricated gap start time |

- Per-order depth uses the actual opposite side needed to close/open, with consistent collateral/YU quantity conversion. Only liquidity reachable by the current order-book execution route counts; AMM depth is excluded unless execution explicitly supports that same route.
- Distinguish no visible depth, no effective depth within bounds, user slippage violation and invalid protocol rate limit. Increasing tolerance is not a universal remedy.
- Official GOOD/OI Capped/Makers Only/Halted and maturity must map explicitly to operation permissions. Existing Normal/CloseOnly/Paused normalization must be validated against authoritative semantics before reuse; absent mappings do not become normal.
- Existing coexistence-margin observations describe Open only and must not satisfy default atomic-roll margin checks. Introduce atomic-roll measurements and keep legacy evidence/rules identified by workflow, without relabeling historical values.
- USD margin displays require a fresh collateral price; native collateral values can remain valid when USD conversion is unknown. Missing batch fields may require a narrow adapter correction; do not use its current zero fallback as verified evidence.
- Economic comparison uses the same quantity and horizon for alternatives, avoids double-counting old exit PnL or fees, and presents assumptions. Negative next carry is a WARNING under existing rules, not proof that execution is impossible.

### Readiness, freshness and alert behavior

- Readiness is independent of severity: executable, blocked, or UNKNOWN. A confirmed blocker remains visible when other evidence is unknown; mark the report incomplete as well.
- Executable requires all mandatory permissions, plan checks, fresh effective-book evidence, account readiness and complete passing batch simulation. Individual quotes or a zero perpetual price net exposure cannot establish it.
- Initially retain the existing 12-second live-review quote age as the atomic readiness maximum for order books and full simulation; state/account evidence uses documented source-specific limits compatible with that result. Reuse existing refresh scheduling: if a slow poll cannot maintain live readiness, show an indicative estimate and age, not executable.
- Preserve existing active-tab refresh, cache and distant-maturity behavior. Only complete current positions proving at least 14 days allow PAUSED for window-specific actionable checks; PAUSED is neither OK nor UNKNOWN. Always retain available maturity facts and measured funding-gap abnormalities.
- Within the less-than-14-day window, confirmed inability to roll the target quantity is WARNING; within less than one day it is CRITICAL. Preserve strict boundary operators and make window configuration explicit. UNKNOWN does not become a fabricated blocker, but approaching maturity and missing evidence remain separately visible.
- A usable full-target plan is not a guarantee that book depth will persist until execution; execution continues to reprice and enforce its existing atomic gate.
- Show four-order rows, minimum coverage, estimated/confirmed quantities and residual, margin and reason details. Provide inspect/requote navigation using existing read-only interactions; do not auto-raise slippage or auto-select a smaller trade.
- Do not claim “展期切换完成” from a passing quote. It requires actual position/result evidence. “展期结算完成” additionally requires final old-leg settlement, release and reconciliation evidence; absent evidence remains UNKNOWN.
- Do not change the standalone monitor's notification/debounce state from Risk. Catalog additions must retain shared rule semantics and Python/UI parity where both evaluate these rules.

## Testing Decisions

- Test observable API and page results using the existing rollover route fixtures, pair/rollover simulations and Risk page/catalog tests. Avoid tests of private helper structure or snapshot text alone.
- Main seam: fixture-backed rollover simulation response and current account evidence to rendered Risk result. Verify identities, values, units, reasons, readiness, severity and independent UNKNOWN facts together.
- Cover a complete four-order pass, each of the four orders independently short of depth, empty book, visible-but-out-of-bound depth, insufficient reserve, slippage violation and protocol-limit violation despite acceptable average APR.
- Cover valid old close under a reduce-only mode with prohibited new entry, makers-only old exit, halted market, expired old market, unknown official mode and account-specific exception without proof.
- Cover candidate absence with complete versus incomplete listing, wrong venue/side/collateral, unequal moved quantities, unsupported subaccount and residual old quantity after a partial planned roll.
- Cover batch margin succeeding only after old closes release funds, genuine shortfall, absent post-roll fields, unknown conversion price, incompatible isolated bucket and Gas auto-top-up feasible versus impossible.
- Cover failed/revoked/expired authorization evidence, wrong signer account and unavailable execution capability without exposing credentials.
- Cover exact 14-day/1-day and 12-second freshness boundaries, stale source with fresh HTTP receipt, incomplete account evidence, account/candidate switching and recovery from unavailable simulation.
- Cover known blockage plus unknown evidence, economically poor but executable plan, PAUSED separate from OK, and no automatic clearing of an unresolved severe condition.
- Assert Risk polling cannot invoke signing, submission, authorization, top-up, background monitor start or notification mutation. Use offline stubs; live order tests are not required or permitted by this spec.
- Add focused calculation tests only for unit conversions, four-order minimum and bound intersections not sufficiently observable at the main seam. Run appropriate offline checks and real browser acceptance for the resulting UI, including narrow viewport and account switching.

## Out of Scope

- Implementing or changing trade execution, FOK/atomic guarantees, automatic rollover scheduling, position adjustment, transfers or authorization.
- Extending Open only with its own full risk design; it retains separate funding-overcoverage and coexistence-margin semantics.
- A new collector, WebSocket infrastructure, persistent order-book history store or forced-refresh system.
- Collection of 5-minute/1-hour historical volume, time since last market trade, spread history and depth persistence. Current 24h market volume, OI, APR spread and visible/windowed depth are now explicitly included in phase one; none replaces four-order effective depth and batch simulation.
- Automatic maximum-size optimization without bounded validated batch simulations; do not label book-only capacity as guaranteed executable capacity.
- Choosing a new trading strategy, changing the perpetual pair, or inferring market permissions from volume/order-book activity.
- Enabling previously hidden historical risk checks or changing unrelated risk categories.

## Further Notes

- This is a follow-up to the completed Risk maturity/rollover work. It refines default atomic-roll coverage without rewriting the original completed ticket or its history.
- Domain terms follow the project glossary: 原子展期、资金费缺口、资金费过覆盖、永续价格净敞口、展期切换完成、展期结算完成. There is no applicable ADR directory in the current checkout.
- Follow-up liquidity diagnostics may add market-wide trades/OHLCV and sampled depth persistence. Account-only fill history is not market volume; a depth disappearance alone cannot be labeled a cancellation without order/event evidence.
- Official reference: [Boros market modes](https://docs.pendle.finance/boros-docs/boros-systems/orderbook), [API](https://docs.pendle.finance/boros-dev/Backend/api), [execution/liquidity guidance](https://docs.pendle.finance/boros-dev/Backend/best-practices), [fees](https://docs.pendle.finance/boros-docs/boros-systems/fees).
- Published implementation issue: [01 — 原子展期风险监控](issues/01-atomic-rollover-risk.md).

- 2026-10-07 用户调整：第一阶段优先逐 market 流动性获取与展示；按 02–10 拆分，上述 Delivery Phases 为当前交付顺序。
