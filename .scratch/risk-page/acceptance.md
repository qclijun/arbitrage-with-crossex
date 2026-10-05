# Risk 页面验收记录

审查基准：`03528c1`。实现、离线验收与审查修正覆盖本目录全部八张票。

页面从权威目录枚举启用检查；当前为 29 项、61 个指标。三个禁用检查不出现。所有检查都有详情、单位、有效阈值、来源、观察时间、TTL、覆盖状态、缺失原因与建议动作。自动来源没有可信证据时显示 UNKNOWN；这不构成实时账户或通知部署验收。

## 通用证明

| 要求 | 实现与证明 |
| --- | --- |
| 标签、深链接、持久化与可访问状态文本 | `App.tsx` / `TabBar.tsx` 复用标签注册；`App.hiddenTabs.test.tsx` 覆盖 Risk 可见、隐藏和返回行为。原标签与分享机制沿用。 |
| 全目录、全指标与禁用项排除 | `risk-rules.test.ts` 检查目录和 61 个指标；`RiskPanel.test.tsx` 用批准的 synthetic API 响应验证全部指标可见、覆盖完整、禁用项不存在及所有请求为 GET。无证据时全部启用检查保留 UNKNOWN。 |
| 规则、单位、时钟与恢复 | `src/core/risk.ts` 使用同一 JSON 目录/契约；`risk-rules.test.ts` / `risk-parity.test.ts` 覆盖严格边界、五种比较、无效类型/枚举/count/unit、未来/过期、3% 恢复迟滞、缺证据保留 CRITICAL，以及 collector/notification 状态的 Python 对照。 |
| 查询、缓存与隔离 | 复用账户、持仓、抵押品、资产、订单、交易组合等 hooks 和键；`App.hiddenTabs.test.tsx` 检查原轮询政策。`RiskPanel.test.tsx` 验证钱包/凭据切换及资产窗口同步；`credentials.test.ts` 验证成功 PUT 旋转 opaque identity。 |
| 时间和历史值 | 缓存的每个 producer promise 绑定不可变 value/time；并发 supersede 回归在 `cache.test.ts`。后台失败的共享旧快照仅作为历史，首次打开 Risk 也保留；源时间、过期与缺失状态在页面可见。 |
| 完全只读 | 页面 GET-only 回归；`risk-evidence.test.ts` 比较读取前后 config/state/heartbeat/observations 原文，验证认证、Host/Origin、scope、字段投影和原始载荷不外泄。没有交易、模拟提交、确认告警、发送消息或启动监控动作。 |

## 八张票的验收映射

1. **Gate 页面与保证金/清算。** 页面与通用 evaluator 交付全部四项及关联数据有效性指标。复用 `liquidationLines` 与既有风险阶梯；覆盖率为 balance/margin，清算距离保留条件模型假设。渲染测试覆盖初载、后台失败、历史值、恢复、scope 切换；adapter 验证缺仓/缺上游时间不能建立完整数据。共享轮询由隐藏标签测试验证。
2. **稳定币负债与利息。** 使用 `/account` 和既有 `/account/interest` 借款桶。逐 venue/coin 检验 liability/borrow/rate/cost，保留免息桶口径与 USD 平价估值说明。`riskSources.test.ts` 覆盖完整零债、缺币/缺债、负债负值、重复资产、缺/负利率、错桶和利息失败时账户指标仍有效；页面展示 USD/day 与高负债警告。现有 interest/account 注入测试证明账户缓存共用。
3. **ETH 抵押池与代理。** 仅使用地址/subaccount/tokenId=2/cross marketAcc 对应池。IM/MM 不依赖美元价格，gas 与抵押品分列；approval/gas 复用原读取者与缓存，仅配置 root/子账户有效。adapter 覆盖缺价格、零保证金、无池、错误池、部分持仓与失败后的历史值；渲染与 API 覆盖陌生钱包、未核验 scope、无状态不是零。原 collateral/agent 注入测试保留通过。
4. **对冲与执行。** 资产 owner 附带独立于价格的实际 Boros 数量、方向和市场元数据；perp 使用原 exposure 归一化（含合约乘数）。显式四腿基线只读、scope 验证，缺基线不自动建立。价差/MTM/条件收益使用既有数据与财务模型；收益分母要求实际四腿、数量、市场、费用、开仓和历史一致。adapter 覆盖方向/数量/市场/到期/合约错误、缺基线/价格、部分持仓/不支持子账户；明确区分净价格敞口与资金费数量缺口。完整空执行为零；HALTED、unhedged、pending/quarantine 使用原投影与创建时间，已测严重下界保留，缺失/截断不能为 OK。
5. **净结算和缓冲。** 复用增量 ledger；滚动窗口按 producer 观察时钟 `(through−24h, through]`，显示实际端点。净 ETH 已扣费，不重复扣；已关闭市场仍在 ledger。`risk-settlement.test.ts` / 原 `settlement-ledger-floor.test.ts` / asset-view 注入覆盖边界、完整空窗、重复/冲突、畸形/未来、分页不足、foreign wallet/subaccount，以及有效 BTC/isolated 池排除。adapter 验证同池净流出 runway；零/正净流量或缺证据没有“大数安全天数”。
6. **到期与展期。** 只有完整、受支持当前 ETH cross 持仓证明至少 14 天才 PAUSED，状态不计 OK，既有严重条件保留。实际规模报价要求同方向四腿/精确合约/基线、等量两腿和更晚到期；使用原 notional APR 与执行 book status。adapter 覆盖 14 天精确边界、已到期、错 venue/symbol/size/maturity/方向/基线、深度不足和假定费用。共存保证金与事后 coverage 缺证据保持 UNKNOWN。资金费时长只接受独立 producer 的 scope、当前腿 fingerprint、正缺口连续历史及 TTL；旧 `uncovered_since` 不可信。Python/JS 一致性、连续/变更/部分记录由 `risk-producer.test.ts` 验证，页面访问不创建起点。
7. **市场/稳定币/人工审查。** 只读本机批准的 scoped primitive observations；不从机会列表或平价估值推出市场正常/独立价格。`risk-evidence.test.ts` 覆盖 fresh/expired/future/type/unit/partial/scope、缺字段、基线额外私有键不返回与原始 metric 对象被拒绝。渲染测试展示严重事件和过期报价；最新有效自动值优先于人工值，clear 审查显示“本次核验，不是安全证明”。既有 `--record` 只在独立 producer scope 最近且配置匹配时附带 scope；不会自行采集或通知。
8. **监控与送达。** 分别展示终端 HTTP、独立 collector 完成/失败/heartbeat 与确认送达/队列。最后完成和消息成功保留事件 producer 时间，不随后续 state 文件读取刷新。正整数 message_id 才作为确认送达；没有部署/receipt/scope 不等于零失败。渲染/API 覆盖 fresh heartbeat + expired completion、旧消息 + 队列/失败、未来状态、legacy/错误配置及钱包切换。Python `test_terminal_evidence.py` 覆盖确认 ID 和只读复用 scope 的记录流程；未部署或启动服务。

## 审查

### Standards

首轮三项：缓存 waiter 的时间归属、有效自动值优先、缺省单位契约。均修正并有回归证明。

### Spec

首轮三项：批准字段投影、完成/送达事件时间、首次打开时共享历史快照。均修正并有 API/渲染回归。额外金融匹配问题已补上实际方向、数量、身份与收益分母条件。

最终复查两轴均无剩余阻塞。已修正部分列表严重下界被人工零值覆盖、缺口扩大沿用旧时长，并验证 agent-derived root。缺省原始观察单位按权威合同默认；显式错误单位仍被拒绝，与 Python 保持一致。

## 最终离线验证

| 命令 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| `node node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json` | 通过 |
| 根目录 `node node_modules/vitest/vitest.mjs run --project unit` | 48 文件 / 1835 tests 通过 |
| 根目录 `node node_modules/vitest/vitest.mjs run --project server` | 48 文件 / 604 tests 通过；沙箱外执行，避免既有 installer 的 bash EPERM |
| web 目录 `node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1` | 92 文件 / 1343 tests 通过 |
| `python3 -m unittest discover -s tests/monitor` | 78 tests 通过 |
| web 目录 `node node_modules/vite/bin/vite.js build` | 通过 |
| `git diff --check` | 通过 |

一次并行验证中，既有 PairTicket 测试触发 5 秒超时；该文件单独复测 20 tests 通过，降低并发后的完整 web 套件通过。测试没有提高超时限制或删减断言。

## 验证边界

离线 synthetic fixtures 证明页面、规则、API 与只读行为；没有读取或执行实时账户交易、部署监控、配置通知或运行 `tests/live`。Computer Use inventory 没有可用浏览器，因此未进行真实浏览器截图/视觉 QA；渲染测试检查可访问的状态文本、summary/details 与错误/历史内容。

生产构建已通过；Vite 的大 bundle 提示保留，本任务没有扩展为包拆分重构。
