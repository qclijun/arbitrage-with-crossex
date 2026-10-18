# Rollover 策略与指标审查（2026-10-17）

> 审查对象：[`docs/rollover-strategy-handoff-2026-10-17.md`](rollover-strategy-handoff-2026-10-17.md)（下称 handoff），
> 以及仓库中实际执行的指标脚本、规则代码与账本。
>
> 结论先行：**`rollover.ts` 的资格/原子性规则主体正确；但 handoff 的三个决策信号（静态 A/B、B 的盈亏平衡、
> M1 动作带）互相冲突，关键金额（$27 / $13 / 3.9–4.0%）无法从仓库复现，M4/M5 与风险监控存在实质缺陷。
> 当前不能据此做“终选”。**

## 0. 证据与说明

| 类别 | 文件 |
|---|---|
| 策略 handoff | [`docs/rollover-strategy-handoff-2026-10-17.md`](rollover-strategy-handoff-2026-10-17.md) |
| 盯盘指标实现 | [`scripts/rollover_watch.py`](../scripts/rollover_watch.py) |
| M1–M5 账本 | `data/rollover-watch/observations.jsonl`（2026-10-17 05:39–05:50 UTC） |
| A/B/S* 账本 | `data/risk-monitor/rollover-watch.jsonl`（2026-10-17 09:11 +0800） |
| 展期规则 | [`src/core/boros/rollover.ts`](../src/core/boros/rollover.ts) |
| 配对定价 | [`src/core/boros/pair.ts`](../src/core/boros/pair.ts) |
| 展期经济模型 | [`src/core/boros/rollProbe.ts`](../src/core/boros/rollProbe.ts) |
| 风险监控 rollover 检查 | [`scripts/risk_monitor.py`](../scripts/risk_monitor.py) |
| 计划与契约 | [`ROLLOVER-PLAN.zh-CN.md`](ROLLOVER-PLAN.zh-CN.md)、[`RISK-MONITOR-CONTRACTS.md`](RISK-MONITOR-CONTRACTS.md) |
| 账户快照 | `data/risk-monitor/latest.json`（2026-10-17 14:01 +0800） |

说明：用户最初引用的 `/tmp/rollover-strategy-handoff-2026-10-17.md` 在当前沙箱不可见；同一内容已出现在
`docs/rollover-strategy-handoff-2026-10-17.md`（未跟踪），本文按该副本审查。若两份内容不同，以用户手头的为准。

同日关键数值（来自账本与 handoff）：

- 旧腿：196 HL 30 Oct short 3.9888313，198 OKX 30 Oct long 3.9888313；锁定差 `L = 4.6594%`，剩余 `t_old = 12.95d`。
- 退出执行差 `X = 2.9887%`；新腿 209 HL short / 213 OKX long，执行价差 `S = 2.48%`，`t_A = 40.95d`，`t_B = 28d`。
- 名义本金 `N ≈ $9,653.37`。
- 账本记录：`A = $31.08`，`B = $33.57`，`B−A = +$2.49`，`C = $16.12`，`S* = 3.2077%`。
- handoff 记录：`A 比 B 贵 ~$27`，`A′ 比 B 贵 ~$13`，`B 的净重开盈亏平衡 ~3.9–4.0%`。

Handoff 的正确部分（应保留）：唯一合法目标 209/213 且无 OKX 12-25；FOK/原子证据是硬门禁，
“M1 越档只改变值不值得等，不解除能不能动”；单点读数 ≠ 趋势；全程只读、unknown 不重发；M6 有兜底时间门。
下面的问题不否定这些，而是说**经济性与指标还不足以支撑终选**。

## 1. Handoff 的决策逻辑：三个信号互相冲突

### 1.1 Handoff 自己给出的三条路径

Handoff 第 3 行让下一 session 在 **A（立即全滚）/ A′（试批+主批）/ B（持有至结算+重开）** 之间终选；
第 8–11 行给出关键经济性：

> - **A** 立即全滚 ≈ 比 B 贵 **~$27**
> - **A′** 试批（10-24）+ 主批（10-27/28）≈ 比 B 贵 **~$13**
> - **B** 持有到结算+重开的盈亏平衡：净重开利率 **~3.9–4.0%**

这三条的直读是：**B 比 A 便宜约 $27，B 比 A′ 便宜约 $13；在当前净重开利率 1.769% 远低于 3.9–4.0% 的情况下，B 是经济上最优的。**
Handoff 第 27–30 行却把当前 M1=1.769% 判为“已落入利率下行，立即全滚（A）”档。**两者不能同时成立。**

### 1.2 三个信号互相冲突

把 handoff 的三条放在一起：

| 信号 | 当前读数 | 指向 |
|---|---|---|
| 静态 A/B（第 8–11 行） | A 比 B 贵 $27；A′ 比 B 贵 $13 | **B** |
| B 的盈亏平衡（第 11 行） | 3.9–4.0% | **取决于定义**（见下） |
| M1 动作带（第 17–23 行） | 1.769% < 2.0% | **A** |

“3.9–4.0%”没有说明是“高于它 B 占优”还是“高于它 A 占优”。两种定义都会和另一个信号冲突：

- **定义 1：高于 3.9–4.0% 才轮到 A**（低于它 B 占优）。
  当前 1.769% → B，和静态 A/B 一致；但 M1 带的低端（<2 → A）和高端（≥3.4 → B）都反了。
- **定义 2：高于 3.9–4.0% 才轮到 B**（低于它 A 占优）。
  当前 1.769% → A，和 M1 带一致；但与“A 比 B 贵 $27”矛盾，而且意味着 B 的盈亏平衡比当前高 2pp 以上，
  需要解释为什么。

所以这不是“带子稍微偏了一点”，而是**三个信号至少有一个错**。下一 session 的第一件事是把 breakeven 的方向
定义清楚，再用同一套现金流重算 `$27/$13/3.9–4.0%` 和 M1 带。

### 1.3 静态比较：低 S 通常应偏 B

在“当前 S 与未来 S₂ 取同一水平”的静态比较下，A 与 B 的差别是——

- A 现在锁定新腿 `S` **41 天**，但必须提前平旧腿，付出 `X × N × t_old` 的退出代价；
- B 保留旧腿完整 `L` **13 天**，再以未来 `S₂` 开新腿 **28 天**；
- A 相对 B 的增量 = `S × N × 13d − X × N × t_old − 费用`。
  S 越高，A 多出来的 13 天新腿 carry 越值钱，A 才越可能胜出；S 越低，A 越不该提前付退出代价。
  所以**低 S 应偏 B，高 S 才偏 A**。Handoff 的带把 A 放在低端、B 放在高端，正好相反。

用账本数做一个量级校验（`B−A`，正数表示 A 比 B 贵、B 更优）：

```
B−A = X·N·t_old − S·N·(t_A−t_B) + (f_A−f_B)
    = 10.24 − S×9653×12.95/365 + 0.69
    ≈ 10.93 − S×342.5
```

- `S=2.48%` → `B−A ≈ +$2.44`（A 贵 $2.4，B 略优）；
- `S=1.769%` → `B−A ≈ +$4.87`（A 贵 $4.9，B 更优）；
- `S=3.5%` → `B−A ≈ −$1.06`（A 更优）。

即**大约 S > 3.2% 才轮到 A**。当前 1.769% 在“S₂ 不低于当前水平”的静态假设下明确在 B 一侧；
Handoff 的 3.9–4.0% 比这个 3.2% 高，两者不完全一致（取决于 X、费用和 breakeven 定义），但都高于 1.769%。

**动量情形**：如果 handoff 的“利率下行”是一个明确预测——未来 S₂ 会跌破 A/B 打平（A 锁 1.769 时约 1.1%，
A 锁 2.48 时约 2.1%）——那么低 M1 → A 可以自洽。但 handoff 只给了一天 HL `-0.46pp` 的观察，
没有给出“会跌破打平”的预测或概率。一天的动量不足以支撑 `$27` 的反转，更不足以跳过 A′。

### 1.4 A′ 的定义不足以执行

Handoff 的 A′ 是“试批（10-24）+ 主批（10-27/28）”，但没有给出：

- 试批的**规模**（占 3.9888 的多少？计划 F5 明确取消固定 5%–10% 的比例）；
- 主批的规模、容忍度、每腿滑点上限；
- 试批失败/部分成交/unknown 时的回退；
- 为什么是 10-24/10-27/10-28 这三个日期（没有按计划 §5 的 `T − 耗时 − 恢复 − 余量` 反推）。

A′ 的 `$13` 是“比 B 贵”，但它比 A 便宜 $14；在没有规模与回退定义的情况下，A′ 不能被当作可执行方案，
只能算一个时间上的折中。

## 2. 关键金额不可复现：`$27/$13/3.9–4.0%` vs 账本 `$2.49/3.208%`

Handoff 第 7 行明确说这些经济性是“本对话内计算，未入库，属关键交接数据”。这意味着下一 session
**没有公式、没有输入、没有可复现的脚本**。仓库里唯一可复现的 A/B 账本是
`data/risk-monitor/rollover-watch.jsonl`，它的数是：

| 量 | Handoff | 账本 |
|---|---|---|
| B 相对 A 的优势（`B−A`，正 = B 更好） | **+$27** | **+$2.49** |
| A′ 相对 B 的优势 | **−$13**（A′ 更差） | 未记录 |
| B 的盈亏平衡净重开利率 | **3.9–4.0%** | `S* = 3.208%`（其定义见 §2.2） |

这里假设 `$27/$13` 是**净收益差**；若它们只是执行成本差（未计 A 多出的 13 天 carry），
则不能与账本的 `B−A` 直接比较，需先统一口径。

### 2.1 `$27` 与 `$2.49` 幅度差 10 倍，方向一致

两边都认为 **B 比 A 好**：handoff 说 A 贵 $27，账本说 B 比 A 高 $2.49。差别是**幅度约 10.8 倍**，
不是符号。幅度差这么大，说明至少有一边的现金流/利率口径不同；下一 session 不能把 `$27` 当作“账本数的四舍五入”。

可能的原因（需要 handoff 的公式才能确认）：

1. **A 用 worst net 1.769%，B 用 top-of-book 2.48%**。Handoff 第 28 行用 `1.769%` 验算 M1，
   但账本的 A=31.08 用的是 `S=2.48%`。若 A 锁 1.769、B 的未来 S₂ 取 2.48，A 会比 B 差约 $10；
   若两边都取 1.769，B 只比 A 好约 $4.9；若 A 取 2.48、B 取 1.769，**A 反而比 B 好约 $2.8**。
   也就是说，**在同一个账本模型里，仅改变 A/B 的利率分配，符号就会翻转**。见下表（其余参数同账本）：

| A 锁定的 S | B 未来 S₂ | A | B | B−A |
|---|---|---|---|---|
| 1.769% | 1.769% | $23.4 | $28.3 | **+$4.9**（B 优） |
| 1.769% | 2.48% | $23.4 | $33.6 | **+$10.1**（B 优） |
| 2.48% | 1.769% | $31.1 | $28.3 | **−$2.8**（A 优） |
| 2.48% | 2.48% | $31.1 | $33.6 | **+$2.5**（B 优） |

2. **把退出价差 X 当成成本，而不是“减少旧腿已锁定的 L”**。正确的 A 旧腿增量是
   `(L−X)·N·t_old ≈ +$5.7`；若写成 `−X·N·t_old ≈ −$10.2`，就多算了约 $15.9，足以把 `$2.49` 变成 `$27` 量级。
3. **费用/保证金/永续项的口径不同**（见 §4、§5）。

在 `$27` 的公式公开并对上账本之前，**“A 比 B 贵 $27”不能作为终选依据**。账本自己的 `$2.49` 也只是一个点估计
（§2.3），不足以支撑“B 明显更优”的强结论；但它的幅度与 handoff 差 10 倍，必须解释。

### 2.2 `S* = 3.208%` 也不是 B/A 打平价差

账本记录 `S* = 0.032077`。用记录值反推：

```
S + (B−A)/(N·t_old)
= 0.0248 + 2.49/(9653.37 × 0.03548)
= 0.0248 + 0.00727
= 0.03207  ← 与账本 0.032077 吻合
```

而 `B(S₂) = A` 的解析解是：

```
C + S₂·N·t_B − f_B = A
S₂ = (A − C + f_B)/(N·t_B)
   = (31.08 − 16.12 + 0.75)/(9653.37 × 0.076712)
   ≈ 2.12%
```

账本公式把 `$2.49` 摊在 **12.95 天的旧腿期限**上、而且用加号；它回答的是“未来价差要比现在高多少才算等待补偿”，
不是“B 与 A 打平”。两者相差约 **1.1pp**。同一份记录还说“S₂=2.0% ≈ 与 A 打平”，与 `S*=3.208%` 不能同时成立。

### 2.3 `$2.49` 本身有多稳？

- `$2.49 / $9,653 ≈ 2.6bp` 名义；`$2.49 / $31.08 ≈ 8%` 的 A 收益。
- 只要 S₂ 下降 **0.34pp**（2.48% → 2.14%），B 就与 A 打平；13 天内 0.34pp 的价差波动很常见。
- 用 worst net 1.769% 重算（A/B 同取 1.769），B 仍优约 $4.9，但打平降到约 1.1%。
- 所以账本口径下，“B 略优”是**脆弱的点估计**；handoff 的 `$27` 若成立则是“B 明显优”。两者对风险预算的含义完全不同。

## 3. 指标 M1–M6 逐项审查

### M1 — 新腿净最差 APR

**实现**：`worstSpreadApr − takerDragApr`（[`rollover_watch.py:219-222`](../scripts/rollover_watch.py#L219-L222)）。
`pair.ts` 的 `worstSpreadApr` 已扣 settle fee，`takerDragApr` 是未扣的 taker 年化拖累
（[`pair.ts:724-740`](../src/core/boros/pair.ts#L724-L740)、[`pair.ts:753-759`](../src/core/boros/pair.ts#L753-L759)），
所以这个减法在定义上是“最差档位、扣 taker 和 settle 后的净年化”。

**问题**：

1. **动作带与静态 A/B 冲突**（§1.2）：在 S₂≈当前水平的静态比较下，低 M1 应偏 B，band 却在低端选 A。
   除非给出明确的“S₂ 会跌破打平”的预测，否则不能这样选。
2. **与 A/B 的 S 不是同一估计量**：M1=1.769% 是 worst net；账本 A=31.08 用的是 top-of-book `S=2.48%`。
   同一时段（05:39–05:40 UTC）的记录能同时看到 mark 价差 2.5075%、最差价差 2.0692%、M1 1.769%。
   用哪个算 A、哪个算 B，会改变 A/B 的符号（§2.1 表）。
3. **单行不能判断“利率下行”**：账本有历史行，但脚本从不读取；`M1_LOW=2.0%` 的“falling”没有趋势依据。
4. **`M1_HIGH=3.4%` 与 B 的 3.9–4.0% 也不一致**：如果 B 的盈亏平衡是 3.9–4.0%，为什么 3.4% 就“B 重占优”？
   两个阈值必须统一，否则同一状态会被两个规则同时触发。

### M2 — 退出可交易性

**实现**：`m2_blockers` 取 gate blockers；`m2_exit_crossing_apr` 取 exit sim 的 `slippageApr`
（`= |midSpread − estSpread|`）；`m2_exit_est_spread_apr` 取 exit 的 `estSpreadApr`。

**问题**：

1. **0.487% / 0.5% = 97.4% 容忍度利用率**。本单全量退出已在边缘；下一次报价稍差就会 `venue-refused`。
   Handoff 把 `<0.8%` 当成 OK，但没有“余量”概念。应记录每腿 `estFillSize / sizeWithinTolerance / shortfallSize`，
   并要求利用率有缓冲（例如 <80%）。
2. **`$10 / 0.1pp` 的注释错了约 28 倍**：`0.001 × 9653 × 12.95/365 ≈ $0.34`，不是 $10；$10 是整年名义的量级。
   `0.8%` 阈值对应约 `$2.7` 的 crossing，和账本 B 的 `$2.49` 优势同量级，足以改变结论。
3. **符号/口径未统一**：`m2_exit_est_spread_apr = −3.44%`（平仓对的 signed spread），
   A/B 账本的 `exit_spread_X = +2.99%`（利率差）。两者不是同一个量，必须写明。
4. **只记 gate code**：venue preview 的逐腿 `orders[].error` 只被折进 `venue-refused` 的 message，没有结构化；
   `rollover.ts` 的 `refusalCause` 已区分“深度 / 滑点 / 保证金”，M2 应逐腿记录。

### M3 — OKX 213 深度

**实现**：公共市场的 `notionalOI` 和 `volume24h`，阈值 150 / 10。

**问题**：

1. **单位没标注**：`notionalOI` 的单位取决于抵押品（`oiUsd = notionalOI × collateralPrice`）。
   若抵押品是 ETH，223.9 是 ETH（约 $54 万）；若是 USDT，则是 USD。阈值 150 的含义随抵押品变化。
2. **OI/24h volume 不是本单可成交深度**：若 volume 以 ETH 计，3.99 ETH 占 19.15 的 **20.8%**；
   M3 通过（19.15 > 10）不代表能一次吃掉 3.99。若以 USD 计，比例更夸张。
3. **公共取数 403 不产生 UNKNOWN**（[`rollover_watch.py:192-193`](../scripts/rollover_watch.py#L192-L193)、
   [`113-114`](../scripts/rollover_watch.py#L113-L114)）：M3/M4 缺失会被静默跳过，违反计划“缺失即 UNKNOWN”。

### M4 — 浮动资金费缺口

**实现**：`m4_floating_gap = okx_213.floatingApr − hl_209.floatingApr`，
`>3%` 提示 “plan B gap cost near doubled”。

**问题**：

1. **口径错**：当前账本是**每个 Boros 腿都由同 venue、同规模的永续做资金费对冲**。来自
   `data/risk-monitor/latest.json` 的 `hedge.hl_size_gap_eth`：

| venue | 永续 | 对应 Boros（同 venue） | 差额 |
|---|---|---|---|
| Hyperliquid | short 8.025 ETH | 196 3.9888 + 128 3.6271 + 232 0.4103 = 8.0262 | −0.0013 |
| OKX | long 3.988 ETH | 198 3.9888 | −0.0008 |
| Binance | long 3.627 ETH | 129 3.6271 | −0.0001 |
| Gate | long 0.410 ETH | 232 Gate 侧 0.4103 | −0.0003 |

   因此 `OKX floating − HL floating` 不是“未对冲缺口”，而是两条**已被永续对冲**的 Boros 浮动利率之差。
2. **符号可疑**：若它真是“净收入浮动”，正数是收益；`>3%` 作为成本告警方向相反。
3. **对象错**：B 的空档在 10-30 之后，旧 196/198 已到期；用 209/213 的浮动差描述 B 的缺口，
   既不是旧腿、也不是空档期的实际敞口。真正要测的是 `uncovered_funding_seconds/eth` 和
   每个 venue 的 `Boros floating − perp funding` 基差。
4. **Handoff 的“M4 ≈ 0”不能证明安全**：如果它测的是错误对象，≈0 只是两条 Boros 浮动率接近，
   不代表 B 的空档没有 funding 风险。

### M5 — 账户安全

**实现**：`borosMargin[0].healthFactor / availableToken / availableUsd`，`gasBalanceUsd`，`sim_shortfall`。

**问题**：

1. **`sim_shortfall` 是死字段**：`entry.simulation` 的接口里没有 `shortfall`；`shortfall` 只在
   `PairBlocker` 和 `RollMargin` 上。脚本读 `entry.get('shortfall')` 永远得到 `None`，账本里也是 `null`，
   `if shortfall > 0` 永不触发。**保证金不足检查实际未生效**。正确来源是
   `data.gate.margin.shortfall / availableAfter / availableAfterExit / need`（[`rollover.ts:385-399`](../src/core/boros/rollover.ts#L385-L399)）。
2. **`borosMargin[0]` 不保证是 ETH cross 池**：应按 collateral/token 选池，多池时保留全部并标注。
3. **只查 HF ≥1.5，不查计划要求的 IM ≥1.3 / post-roll coverage**：`shortfall=0` 只说明“此刻刚好够”，
   不说明滚完后还有 1.3 倍缓冲。模拟已返回 `marginRequired / availableAfter`，本可以算
   `rollover.incremental_margin_usd / post_roll_coverage`，但契约里仍是 UNKNOWN。
4. **gas $150→$5 的来源**：Handoff 第 35 行说这是 `gasBalanceUsd` 与 `availableUsd` 混淆、已修复；
   `data/rollover-watch/observations.jsonl` 前几行仍写着 `150.87`，很可能是修复前字段混淆的残留，
   后几行是 `5.13`。因此**不要把前几行当时间序列**；当前 gas ≈ $5.13，仍很薄（阈值 $2 过低）。
5. **没有 Gate 侧保证金检查**：滚期只动 Boros，但永续保证金仍在；计划要求逐账户检查。

### M6 — 时间门

Handoff 第 23 行：10-24 FOK 证据截止；10-26 决策；10-28 主批；10-29 12:00/20:00 UTC 兜底。

**问题**：

1. **固定日期没有按计划 §5 反推**：`last start = min(T, last tradable) − 保守耗时 − 失败恢复 − 安全余量`。
   10-29 20:00 UTC 距 10-30 00:00 UTC 只有 4 小时；四腿原子 tx + 确认 + 失败回退未必够。
2. **10-24 是研究截止，不是执行截止**：即使 FOK 证据提前完成，也不能把主批拖到 10-28/29；
   如果证据 10-26 才齐，A′ 的“试批 10-24”已经过期，方案要重排。
3. **没有“转退出”时刻**：计划要求“转退出的决策时刻不得晚于退出最迟启动”；M6 只排了 roll 的批次，
   没有退出侧的截止。

## 4. A/A′/B 与账本 A/B/C 的对照

Handoff 的三条路径与账本的三条路径不是同一组：

| Handoff | 账本 | 说明 |
|---|---|---|
| A 立即全滚 | A | 同一路径；handoff 记 A 比 B 贵 $27，账本记 B−A=$2.49 |
| A′ 试批+主批 | 未记录 | A′ 是 A 的分批/延迟执行，账本没有对应现金流 |
| B 持有到结算+重开 | B | 同一路径；handoff 的 B 盈亏平衡 3.9–4.0%，账本 S*=3.208% |
| 未列 | C（只持有不重开） | 计划允许的退出/不重开，handoff 未作为终选候选 |

**A′ 的经济性**必须单独算：试批部分按 A 的现金流（早滚），剩余部分按 B（等到 10-27/28 再滚或结算）；
不是简单地在 A 与 B 之间取平均。`$13` 若成立，A′ 优于 A、劣于 B；但 trial 的规模、失败回退、时间价值都未给出。

**账本 C 的永续成本**：C 到 10-30 后，198 OKX 的 Boros long 到期，OKX 永续 long 3.988 失去对应浮动腿；
HL 永续 short 8.025 中属于 196 的 3.9888 也失去对应。要么平掉（成本），要么留裸 funding 敞口。
账本 C=$16.12 只算了旧腿 carry，**高估了 C**，也就低估了 A/B 相对 C 的优势。

## 5. Rollover 规则（`rollover.ts`）审查

### 5.1 正确的部分

- 新到期必须晚于旧到期（[`rollover.ts:215-219`](../src/core/boros/rollover.ts#L215-L219)）；
- 四条腿必须同抵押品（`:220-222`）；
- 新腿必须是旧腿同 venue、同 base、同方向、同规模（`:224-253`）；
- 必须有 venue preview；没有 preview 时 `roll-unpriced` 阻断（`:324-332`）；
- venue 拒绝时逐腿给出原因与补救（`:333-383`）；
- 保证金用 venue 的阶段值 `availableBefore / availableAfterExit / availableAfter / shortfall`（`:385-399`）；
- FOK + 批量 `requireSuccess`；三态 `rolled / refused / unknown`；unknown 不推断成交（`:481-564`）；
- 批量 close 先撤挂单，避免旧腿被遗留挂单重新打开（`borosPair.ts:1182-1185`）。

这些与计划 §§3–6 的“身份/期限/原子性/unknown 禁止重发”一致。

### 5.2 规则漏洞与硬化点

1. **下标耦合**：`evaluateRollGate` 用 `oldLegs[index]` 对 `newLegs[index]`（`:224-253`），而 `rollPlanFor`
   按 venue/base 匹配（`:453-478`）。若 exit/entry 顺序不同（例如 exit 按 OKX/HL、entry 按 HL/OKX），
   gate 会误报 `market-mismatch/sides-mismatch`。应按 venue/base 建映射。
2. **exit 方向没有显式检查**：靠 `intent='close'` 的 reduce-only clamp + `size-mismatch` 兜底；
   错误信息可能是“size mismatch”，不是“方向填反了”。建议显式 `exit-direction` blocker。
3. **零持仓腿**：`heldSide(old)` 在 `currentSize === 0` 时返回 `null`，方向检查被跳过；建议 `nothing-to-close`。
4. **目标市场已有持仓**：gate 只比较 delta，不检查新市场是否已持仓；滚入 128/129 这类市场是“加仓”，
   验收/台账要按 resulting position 处理。至少 warning。
5. **unknown 合成 fill 的方向写死**：`submitBorosRoll` 对 `kind='rollover'` 的 unknown 合成
   `closes` 方向 `'short'`、`opens` 方向 `'long'`（`:529-531`）。若旧腿是 short（196），平仓方向应是 long；
   若新腿是 short，开仓方向应是 short。批量分支用 `o.direction`（`:528`）是对的；rollover 分支应从 plan 取。
6. **没有 post-roll 覆盖率**：`shortfall=0` 不满足计划的 Boros IM ≥1.3、MM ≥1.5；应计算
   `availableAfter / marginRequired` 并对照阈值。
7. **官方 FOK 语义仍未独立核验**：`rollover.ts` 顶部注释把 FOK/原子性写成事实，计划 §3 则明确说
   “尚未独立核验”。venue preview 通过 + `m2_blockers=[]` 不是“必定全量成交”的证明。
8. **部分展期**：`rollPlanFor`/`reducingOrderSize` 支持部分规模，但 gate 没有“剩余旧腿与永续如何匹配”的检查；
   计划的路径 B 要求剩余 `Q−q` 与永续协调关闭，指标卡也没覆盖。

## 6. 风险监控与官方契约的脱节

1. **候选 venue 写死**：`risk_monitor.py:729-734` 只接受 `shortLeg = HYPERLIQUID` 且 `longLeg = BINANCE`。
   当前要滚的是 196 HL short / 198 OKX long，目标是 209 HL short / 213 OKX long；OKX 永远不会被选中。
2. **`current_maturity` 用 `max`**：`:728` 取所有 Boros 仓的最大到期（当前是 128/129 的 12-25），
   而 `rollover_days_to_maturity` 用 `min`（`:114-127`，10-30）。窗口按 10-30 开，候选却要求 >12-25，
   11-27 被排除。即使 venue 过滤修好，`next_net_apr` 仍然是 UNKNOWN。
3. **`hedge.maturity_match / direction_match` 只比 HL vs Binance**（`:511-517`）：同 venue 多仓时用
   `{venue: 最后一条}`，196/198/232 可能被 128 覆盖；显示 OK 不代表 10-30 的 HL/OKX 对匹配。
4. **`depth_coverage_ratio` 名不副实**：`:738-740` 只看 `bookStatus === 'ok'`，不是“实际 size 的覆盖比例”；
   契约写的是“实际 size 模拟/盘口及两腿全部费用，不只 mid”。
5. **UNKNOWN 未进入决策**：`hedge.market_identity_match`、`rollover.incremental_margin_usd /
   post_roll_coverage / uncovered_funding_*` 都是 UNKNOWN（见 `latest.json`）。计划“缺项不启动”直接适用；
   盯盘的 M1–M5 没有替代它们，也没有在 verdict 里引用。
6. **两套账本**：`data/rollover-watch/observations.jsonl`（M1–M5）与
   `data/risk-monitor/rollover-watch.jsonl`（A/B/S*）schema 不同、时间不同、互不引用；
   一个用模拟最差净价，一个用 opportunities/asset-view 的 top-of-book。无法回答“这次决策到底用了哪组数”。

**建议**：先把 `risk_monitor.py` 的 rollover 候选改为“按当前持仓的 venue 对 + 最早到期”生成，
再用同一套模型输出 `next_net_apr / depth_coverage / incremental_margin / post_roll_coverage /
uncovered_funding`；盯盘脚本退化为“只读视图 + 账本”，不再另造一套公式。

## 7. 系统性缺口

1. **11-27 之后没有路**：Handoff 第 6 行明确“不存在 OKX 12-25 市场，更晚目标数为 0”。所以滚到 11-27
   只是把问题推迟 28 天；11-27 到期后要么退出、要么换到 128/129（HL/Binance，不同 venue，需另审）。
   A/B 以 11-27 为共同终点，等于默认“到期退出”；应把终点的退出/资金释放写进现金流和验收。
2. **全量 3.9888 不是唯一选项**：退出在 0.5% 容忍度下已用 97.4%；OKX 213 的 24h 量 19.15（若以 ETH 计，
   本单占 20.8%）。计划要求先找“可行规模 q”，允许部分展期；指标卡只模拟全量。
   `fitAtBand / rollFitSize` 已在 `rollProbe.ts` 里，盯盘没有用。
3. **永续 funding / 平仓成本未计**：A/B 都未计；B 在 10-30 后有裸奔窗口；C 若不平永续则一直裸奔。
4. **费用口径未对账**：模拟的 taker drag 约 `0.3002%`，四腿约 `$4.3`；模型用 `$1.44`。绝对收益被高估约 $2.8。
5. **资金费基差**：每个 venue 的 `Boros floating − perp funding` 未计；可能 ±$10 量级，和 $2.49 同阶。
6. **硬编码 market ID/size**：脚本注释说 size 是 2026-10-17 的实盘；持仓变化后指标静默失真。
   232（HL-Gate 0.4103，11-27）与 128/129（12-25）未进入决策。
7. **单点读数 ≠ 趋势**：handoff 自己第 43 行也提醒了，但动作带仍按单点 M1 触发；账本历史没有被消费。

## 8. 优先修复清单

### P0（在终选前必须解决）

1. **修正/撤回 M1 动作带**：先定义 breakeven 方向；在静态比较下低 M1 应偏 B、高 M1 才偏 A。
   若坚持“低 M1 → A”，必须给出 S₂ 跌破打平的预测和概率，并说明它如何覆盖 `$27` 的静态劣势。
2. **对账 `$27/$13/3.9–4.0%` 与账本 `$2.49/3.208%`**：公开 handoff 的公式、输入、费用和 A/B 各自的
   entry rate；在量级和利率口径对上之前，不得写“终选”。
3. **统一 A/B 的利率口径**：A 与 B 的 S/S₂ 必须同取 worst net 或同取 exec；列出四种组合的符号
   （§2.1），并明确终选采用哪一种。
4. **重算/重命名 `S*`**：`S_breakeven = S − (B−A)/(N·t_B)`，约 2.1%；若要“等待补偿”，另设 `S_hurdle`。
5. **修正 M5**：读 `gate.margin.shortfall / availableAfter / need`；`sim_shortfall` 删除；`null` → UNKNOWN。
6. **重定义 M4**：按 venue 计算 `Boros floating − perp funding` 的基差；B 的空档用
   `uncovered_funding_seconds/eth`；确认符号后重设阈值。
7. **修 `risk_monitor.py`**：`current_maturity` 改 `min`；候选 venue 从持仓推导（HL/OKX）；
   `depth_coverage_ratio` 用实际 size。
8. **在 verdict 里引用官方 UNKNOWN**：`hedge.market_identity_match`、`rollover.uncovered_funding_*` 等
   未解决时，输出“不可执行/待核验”。

### P1

9. **定义 A′**：试批规模、主批规模、容忍度、失败/unknown 回退、10-24/27/28 的依据；否则 A′ 不能与 A/B 比较。
10. **M6 按计划 §5 反推**：`T、last start、转退出时刻`；10-29 20:00 UTC 的 4 小时余量需要证明。
11. **费用与永续现金流**：A/A′/B/C 都加永续 funding；C 加平永续成本；费用用 `takerDragApr × N × t`
    或 sim 的 `costToCrossSize` 复核。
12. **部分展期/可行规模**：输出每腿 `estFillSize / sizeWithinTolerance`、最大可滚规模、该规模下的 A/B。
13. **M2 校准**：阈值与 `B−A`/费用同量级；加“容忍度利用率”；注释的 $/0.1pp 修正。
14. **M3 校准**：用“本单/24h volume、本单/OI”，标注单位；公共取数失败 → UNKNOWN。
15. **单一账本**：M1–M6 与 A/A′/B 合并为一行一次决策，带 `simulatedAtMs`、`estimator`、`size`。

### P2

16. `evaluateRollGate` 按 venue/base 配对，去掉下标耦合。
17. exit 方向显式 blocker；零持仓显式 blocker；目标已持仓 warning。
18. unknown 合成 fill 的方向从 plan 取，不写死。
19. 硬编码 market ID/size 改为从持仓读取并断言；232 与 128/129 纳入组合视图。
20. 计划文档 §4 加“浮动资金费与永续对冲”，§5 加“11-27 之后的去向”。

## 9. 复核方法与待确认问题

只读复核命令（不会下单）：

```bash
# 复现指标（需要终端在线；--skip-simulate 只取公共/账户数据）
python3 scripts/rollover_watch.py --skip-simulate

# 复现账本 A/B 的算术
python3 - <<'PY'
N=9653.37; L=0.046594; X=0.029887; S=0.0248
t_old=12.95/365; t_A=40.95/365; t_B=28/365
fA, fB = 1.44, 0.75
C=L*N*t_old
A=(L-X)*N*t_old + S*N*t_A - fA
B=L*N*t_old + S*N*t_B - fB
print(C, A, B, B-A, (A-C+fB)/(N*t_B), S+(B-A)/(N*t_old))
PY
```

待确认（需要 handoff 的公式或账户口径）：

- `$27` / `$13` 的逐项现金流是什么？A 与 B 各用了哪个 entry rate（1.769% 还是 2.48%）？
- `B 的盈亏平衡 3.9–4.0%` 是“B 优于 A 的下限”还是“A 优于 B 的下限”？方向决定 M1 带怎么改。
- A′ 的试批规模、主批规模、失败回退是什么？为什么是 10-24/27/28？
- 永续是否确认为“资金费对冲”（第 3 节 M4 的四个 venue 规模吻合）？若是，M4 必须重定义。
- C 的永续在 10-30 是平掉还是保留？若是平掉，平仓成本应计入 C。
- 11-27 之后是退出，还是换到 128/129（HL/Binance）？若是后者，这是另一笔需另审的换仓，不是 roll。
- `data/rollover-watch/observations.jsonl` 前几行的 gas 150.87 是修复前字段混淆的残留吗？
  若是，账本需要标注版本，避免把修复前后的行当趋势。

> 本文只读审查，不构成交易授权；任何 roll/execute 仍需按 `ROLLOVER-PLAN.zh-CN.md` §8 的启动决策单逐项填写并通过。

## 10. 附录：handoff 逐行核对

以 `docs/rollover-strategy-handoff-2026-10-17.md` 的 72 行为准（行号为该文件行号）：

| 行 | Handoff 内容 | 审查结论 |
|---|---|---|
| 3 | 任务：A / A′ / B 终选 | 方向对；但三个信号互相冲突，见 §1.2 |
| 7 | 198 OKX long + 196 HL short，各 3.9888313，10-30 到期 | 与账本一致；232（11-27）与 128/129（12-25）未纳入，见 §7 |
| 8 | 唯一目标 209/213；无 OKX 12-25 | 正确；也意味着 11-27 之后无路，见 §7.1 |
| 9–13 | A 比 B 贵 $27；A′ 贵 $13；B 打平 3.9–4.0% | 未入库、不可复现；与账本 $2.49/3.208 差 10 倍；先对账，见 §2 |
| 17–24 | M1–M6 指标卡 | M1 带与静态 A/B 冲突；M2 97.4% 利用率；M3 单位/绝对阈值；M4 口径错；M5 shortfall 死字段；M6 固定日期，见 §3 |
| 28–29 | M1=1.769% → 立即全滚 A | 1.769% 验算对；动作与 $27/静态 A/B 冲突，见 §1.2、§1.3 |
| 30 | M2 blockers 0；crossing 0.487% <0.8% OK | 0.487/0.5=97.4%，不是“OK”；0.8% 阈值与 $2.49 同量级，见 §3 M2 |
| 31 | M4 浮动差 ≈0 | 测的是已被永续对冲的两条 Boros 浮动率之差；≈0 不证明 B 空档安全，见 §3 M4 |
| 32 | M5 HF 3.28；gas $5.13；shortfall 无 | “shortfall 无”来自死字段，不是证据；gas 前几行 150.87 是修复前残留，见 §3 M5 |
| 37 | FOK 硬门禁；“M1 越档只改值不值得等” | 正确，应保留；但“值不值得等”的方向没有定义，见 §1.2 |
| 38 | 只读；unknown 不重发 | 正确 |
| 39 | 单点≠趋势；M1≥2 时 A′ 恢复 | 方向对；A′ 无规模/回退定义，带子仍按单点触发，见 §1.4、§7.7 |
| 43–45 | 下一 session 动作 | 对；应加“对账 $27 vs $2.49”“定义 breakeven 方向”“修 M5/M4/risk_monitor” |
| 52–57 | 关键文件 | 对；`risk_monitor.py` 的盲区不止“每 venue 一条”，还有 HL/Binance 写死 + `max(maturity)`，见 §6 |
| 66 | 持续推进不停顿 | 本审查按此执行；下一步可直接进入修脚本/建模型 |
