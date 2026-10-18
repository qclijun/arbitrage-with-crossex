# Handoff：10-30 持仓展期策略终选（2026-10-17）

下一 session 任务（用户指定）：**综合判断，选择合适的 rollover 策略**——在 A（立即全滚）/ A′（试批+主批）/ B（持有至结算+重开）之间给出终选结论、理由和回退触发条件。

## 背景与既有结论（勿重复研究，按路径引用）

- 持仓：Boros mkt **198**（OKX ETHUSDT 10-30，LONG）+ **196**（Hyperliquid ETH 10-30，SHORT），各 **3.9888313 ETH**，2026-10-30 00:00 UTC 到期；ETH cross pool。账户 root 与 terminal 地址见 `data/risk-monitor/config.json`；token 在仓库根 `api-token`（勿提交、勿外传）。
- 唯一合法展期目标：11-27 对 **213**（OKX long）+ **209**（HL short）。不存在 OKX 12-25 市场，更晚目标数为 0。
- 方案经济性对比（本对话内计算，未入库，属关键交接数据）：
  - **A** 立即全滚 ≈ 比 B 贵 **~$27**
  - **A′** 试批（10-24）+ 主批（10-27/28）≈ 比 B 贵 **~$13**
  - **B** 持有到结算+重开的盈亏平衡：净重开利率 **~3.9–4.0%**
  - 注意：早期 $44–50 的成本估算已修正为上述数字，勿沿用旧值。

## 指标卡 M1–M6（已实现为 `scripts/rollover_watch.py`）

| 指标 | 含义 | 阈值 |
|---|---|---|
| M1 | 11-27 入场对净最差可执行 APR（worstSpreadApr − takerDragApr） | <2.0% → 利率下行，滚 A；2.0–3.4% → 中性，默认 A′；≥3.4% → B 重占优 |
| M2 | 退出侧 0.5% 容忍下的 blockers 与 crossing | blockers>0 或 crossing >0.8% → 权衡 B/分批 |
| M3 | OKX 213 深度（OI、24h 量） | OI<150 或量<10 → 提前主批 |
| M4 | 浮动利率差 OKX−HL（方案 B 的 gap 成本） | >3% → B 成本近翻倍 |
| M5 | HF / 可用 / gas / shortfall | HF<1.5 停加批；gas<$2 先补；shortfall>0 不得启动 |
| M6 | 时间门 | 10-24 FOK 证据截止；10-26 决策；10-28 主批；10-29 12:00/20:00 UTC 兜底 |

## 当前最新读数（2026-10-17，脚本已验证）

- **M1 = 1.769% < 2.0% → 已落入"利率下行，立即全滚（A）"档。**
  - 逐腿确认是真实行情：OKX 213 worstApr 5.136%（稳定），HL 209 **7.205%**（早间 7.67%，跌 0.46pp）。验算 7.205−5.136−0.3%（费）= 1.769% 吻合，非口径错误。
- M2：blockers 0；exit crossing 0.487%（<0.8% OK）。
- M4 浮动差 ≈ 0。
- M5：HF 3.28；可用 0.0622 ETH（~$150.8）；gas $5.13（来自 simulate 的 gasBalanceUsd，勿与 availableUsd 混淆——已修复）；shortfall 无；entry IM ≈ 0.0405 ETH。
- 账本 `data/rollover-watch/observations.jsonl` 已有 ≥3 行，可看趋势。

## 硬约束（终选建议必须遵守）

1. **FOK/原子成交语义官方证据仍未核验**（`docs/ROLLOVER-RESEARCH.zh-CN.md` §6.1 有文档与合约提交链接；缺的是针对当前部署的核验）。`docs/ROLLOVER-PLAN.zh-CN.md` 门禁：证据未齐 → `/api/boros/roll/execute` 不得启动。**M1 越档只改变"值不值得等"，不解除"能不能动"。**
2. 全程只读；未获用户明确指令不得下单/撤单；实盘测试需 LIVE_TRADE_ACK；unknown 状态 → 不重提交。
3. 单点读数 ≠ 趋势：若 M1 回到 ≥2.0%，A′ 默认自动恢复。终选必须基于趋势 + FOK 证据进度，不是单次 M1。

## 下一 session 建议动作

1. `python3 scripts/rollover_watch.py` 取新读数，与账本历史对比 M1 趋势（`--skip-simulate` 可快速看 M3/M4/M5）。
2. 核对 FOK/原子证据的最新状态（是否已有人完成部署字节码核验）。
3. 输出终选：策略 + 理由 + 回退触发条件 + 与 M6 时间门的衔接。

## 关键文件（引用，勿复制内容）

- `docs/ROLLOVER-PLAN.zh-CN.md` — 治理与硬门禁（binding）
- `docs/ROLLOVER-RESEARCH.zh-CN.md` — 官方规则证据（FOK、原子批、结算语义）
- `docs/ROLLOVER-REVIEW.zh-CN.md`
- `scripts/rollover_watch.py` — 一键采集（M1–M5 + 判定，JSONL 留痕；只读，stdlib only）
- `data/rollover-watch/observations.jsonl` — 观察账本
- `scripts/risk_monitor.py` — 已知盲区：每 venue 只记录一条持仓（F4）
- `src/server/routes/borosPair.ts` — roll simulate/execute 语义（leg direction=下单方向；0.25% 默认容忍是 MAX）
- `src/core/boros/pair.ts` — 费用模型（M1 口径出处）
- 记忆：`~/.claude/projects/-home-jerel-workspace-GitHub-arbitrage-with-crossex/memory/boros-1030-rollover-position.md`

## Suggested skills

- 本次对话未使用任何项目/用户 skills，暂无匹配域技能可推荐；依赖通过 `AGENTS.md`（repo 约定）与上述文档获取。
- 若终选完成后需要再交接，可再调用 `/handoff`。

## 环境与协作注意

- 用户以中文交流，期望**持续推进不停顿**（本对话两次"怎么停下来了"）——宁可边做边说，不要静默等待。
- 用户全局 CLAUDE.md：命令输出经 rtk 压缩，视为完整结果；仅在结果不可用时用 `rtk proxy <cmd>` 重跑。
- git 分支 `dev_0929`；`scripts/rollover_watch.py` 目前未跟踪。是否提交由用户决定；repo 约定**永不提交** `data/`、`api-token`、`.env`、SQLite、实盘 fixture。

## 脱敏说明

本文档不含 token 内容、助记词或私钥；账户地址仅以 `data/risk-monitor/config.json` 的 `root` 字段指代。
