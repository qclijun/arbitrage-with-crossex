# 工单05原型核查

基准：f0a10ef621402ce51ee22f52feb24425bb29f3f1，docs/perp-funding-opportunities。
范围：独立开发原型与规划文件，不读取账户、凭据或实盘数据。

## 定位与隔离

- 图Scout定位App.App（App.tsx:46–322）、FundingSpreadsPanel（panels/FundingSpreadsPanel.tsx:91–208）、TabBar；只作正向定位，不声称穷尽影响。generation 2026-10-27T00:29:29Z。
- App/FundingSpreadsPanel/package/Vite配置及styles/Tailwind/main路径覆盖信号无记录问题、metadata_match；不存在的index.css和未跟踪tsconfig均回源确认：实际样式为styles.css，tsconfig已读。图为best-effort，不是完整性证明。
- App保留真实hooks、API/鉴权与所有生产入口；独立HTML＋专用Vite配置没有API proxy，绑定127.0.0.1:8795。原型仅引用React、fixtures与展示模块，所有交互为内存状态。正常生产index不导入原型，生产bar有DEV门控。
- prototype技能要求可丢弃实现，无专用测试/生产抽象；implement要求的既有完整离线检查与build仍运行。当前分支保存可审阅资产，用户验收前不resolved；06前不折入真实页面。

## Chrome交互记录

| 检查 | 观察 |
|---|---|
| A/B/C与浮动切换条 | 三种结构可切，URL variant可分享；截图已保存 |
| 输入框方向键 | ArrowRight保持B；点击非输入标题后右键切C |
| 完整ETH规模 | 填入数量1、2×/2×、short maker、7天；预览可用 |
| 正常金额 | 逐腿3500/3495名义金额、12.2%/5%年化；净日收入约0.6611 USDT，7天正常路径约−1.92，非正风险突出（展示按当前四舍五入） |
| 800ms长按 | 仅生成DEMO-INTENT-001→DEMO-DEAL-001；普通短按未创建 |
| 部分成交 | A0.4/B0.1、残余0.3，不按B reservation填平 |
| UNKNOWN与恢复查询 | 保留同一意图；已知累计不抹除，不重发/新建；执行参数锁定 |
| 账户费率缺失 | VIP0假设参考可见，真实费用/全成本UNKNOWN，预览阻止 |
| 历史stale | 明确暂停排名/下单，缓存按身份观察；完整重验产生snapshot #2 |
| 提交时变价 | 成本变化+0.35返回新预览，风险/转换授权清空，意图数仍0 |
| 10秒过期 | 倒计时“已过期”，长按按钮禁用 |
| 编辑数量 | 返回编辑后改1.5，旧preview-box消失，必须重预览 |

| 零/负历史情景 | HYPE零差与ETH负差仍可预览，净日收入≤0显示无有限回本，零负方向须另勾风险；非正持有情景突出 |
| NEW短窗口 | 30天UNKNOWN，7天±15%历史合格但不在执行白名单，仍仅观察 |
| 跨单位 | 1000PEPE/PEPE保留历史观察，禁用规模映射与执行；不隐式换算 |
| 不同稳定币 | BTC USDT/USDC历史可比但换汇证据缺失，金额/准入UNKNOWN，不假定1:1 |
| 其他当前门槛 | 深度不足、场外归属差异、反向旧净仓、同合约活动执行均分别阻止；完整刷新后正常样本可预览 |
| 归属反馈 | Positions/Risk入口及4.03数量拆分、当前认领条件、汇总与切片UNKNOWN说明可见 |
| 浏览器错误 | 最终Chrome页面error日志为空；无真实API或交易交互 |
| 分页与正值过滤 | 下一页到2/4；只看正值后7条样本、重置为1/2页；零负/未知未被默认删除 |
| maker限价绑定 | long maker为3495；改short后旧预览消失，新预览3500，提交复制限价；刷新缓存后原执行仍绑定snapshot #1和3500 |
| UNKNOWN摘要 | 周期未证明明确标UNKNOWN，与已证明不支持区分；已更新所有截图 |

生产构建通过，产物全文扫描无PROTOTYPE 05、DEMO-INTENT-或funding-prototype字符串；独立入口没有进入正常bundle。32份文档116个本地链接通过，17票依赖无环；暂存文本预算通过。详细日志在/tmp/perp05-doc-validation.txt及perp05-web-build.log。

双轴审查Standards无发现；Spec两项P2（未知周期误称不支持、maker限价不明确）均已最小修复并复核，未解决0，见/tmp/perp05-standards-review.md和perp05-spec-review.md。修复后的web typecheck通过，原FundingSpreadsPanel单测1项通过。

验证结果：root共137文件、3278项通过、8项跳过；web降低并发全量109文件、1710项通过（271秒），合计4988项通过、8项跳过。web build通过。完整yarn verify未一次全绿：首次在web typecheck阶段非零结束且无诊断；最终版本复跑root及typecheck通过，但web的App.setupOnce与PairTicket各一项超时。两文件单独复跑26项全部通过，再以--maxWorkers=2 --minWorkers=1跑完整web套件全部通过；没有改动这些既有测试或提高超时，不能把时序原因当作已证实结论。

日志：/tmp/perp05-verify.log、perp05-verify-final.log及.exit保留原失败；perp05-focused-timeouts.log、perp05-web-tests-bounded.log为复核；perp05-typecheck-review-fixes.log与perp05-web-build.log为类型/构建结果。

以上代理核查记录不替代用户验收，未证明真实服务端或交易执行。原型专用测试按技能跳过；现有完整离线套件仍用于保护周边产品。

## 用户验收记录

2026-10-27，原型7b74406交付后，用户明确选择“A 排名工作台，交互可验收（推荐）”。A布局与展示交互据此验收，05 resolved；B/C保留比较资产。此后本轮仅更新文档状态、决定及依赖，不改代码/截图，不重跑已记录的产品套件；本轮32份文档、121个本地链接及17票依赖无环检查通过，816个跟踪文本预算通过；结果见/tmp/perp05-acceptance-validation.log。06解除前置阻塞但仍open，实施与发布仍未获准入。
