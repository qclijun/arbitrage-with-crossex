Status: ready-for-agent

# 四腿交易永续 Maker 报价与有限改价

## Problem Statement

四腿资金费套利在 Boros 两条利率腿建立后，需要建立对应的永续双腿。当前默认 maker 报价位于同侧最优价之外一个买卖价差，挂单存续期间不会自动跟随盘口；五分钟等待结束后，剩余量转 taker。用户选择 maker＋hedge，却可能经历长时间零成交，最后两条永续都付出 taker 手续费。

当首次 maker 挂单未成交而等待窗口到期时，现有逻辑会撤单并转市价，再由另一条永续腿对冲。手续费率相同时，首次选择可能默认多头作为 maker；本规格改善报价与有限追价，不依赖任何个人成交价格或数量。

用户接受在两条永续尚未成交时较长等待 maker，但要求每次已确认的 maker 成交及时以市价对冲。资金费过覆盖与永续价格净敞口是不同状态，不能把 Boros 双腿已建立但永续均未成交，描述为同等名义本金的裸永续持仓。

## Solution

只在 Boros 已建立后的四腿交易永续对冲流程启用新的 maker 策略：初始买单挂买一、卖单挂卖一，保持 post-only；挂单落后同侧最优价至少两个 tick 且距上次挂单至少十五秒时，进行有次数上限的自动改价。

默认从创建永续 deal 起等待三十分钟，允许下单前调整。部分成交、改价、盘口异常或进程重启都不延长绝对期限。每次确认成交后优先对冲已成交数量；到期撤销剩余 maker、确认最终成交数量，然后以 taker 补齐剩余量。

盘口获取失败或无效时暂停新增 maker 和改价，保留原 maker；期限照常推进。用户明确选择简化处理：不以资金费率、下次结算时间、资金费损失预算或双腿入场基差检查约束等待或追价。

## User Stories

1. As a four-leg trader, I want the new maker policy to apply after my Boros legs are established, so that it improves the intended hedge workflow.
2. As a trader using an ordinary perpetual pair, I want my existing execution defaults preserved, so that this feature does not change an unrelated trade.
3. As a four-leg trader, I want a maker buy to start at the best bid, so that it does not unnecessarily rest behind the current buying queue.
4. As a four-leg trader, I want a maker sell to start at the best ask, so that it does not unnecessarily rest beyond the current selling queue.
5. As a four-leg trader, I want every maker order to remain post-only, so that an aggressive quote cannot silently incur a taker fee.
6. As a four-leg trader, I want valid venue tick and precision rules applied to quotes, so that orders are acceptable to the selected venue.
7. As a four-leg trader, I want the initially selected maker venue to stay fixed, so that the trade does not switch acquire and hedge roles during execution.
8. As a four-leg trader, I want a quote to be reconsidered after it falls behind by at least two ticks, so that it can follow a moving market.
9. As a four-leg trader, I want at least fifteen seconds between maker placement and an automatic reprice, so that small movements do not constantly discard my queue position.
10. As a four-leg trader, I want at most twenty automatic repricing cycles, so that quote chasing is bounded.
11. As a four-leg trader, I want the last maker order retained after the reprice limit is reached, so that exhausting the limit does not itself force a taker fill.
12. As a four-leg trader, I want a default thirty-minute maker window, so that I have more opportunity to obtain maker fills.
13. As a four-leg trader, I want to adjust that window before submitting the deal, so that the waiting period reflects my intent.
14. As a four-leg trader, I want one absolute deadline throughout the deal, so that repricing, partial fills and restarts cannot extend it.
15. As a four-leg trader, I want every confirmed partial fill hedged promptly at market, so that I do not wait with avoidable perpetual price net exposure.
16. As a four-leg trader, I want fills occurring during cancellation included in the final quantities, so that the next order cannot over-acquire or over-hedge.
17. As a four-leg trader, I want cancellation confirmed before replacement, so that two live maker orders cannot acquire the same remainder.
18. As a four-leg trader, I want only the unfilled remainder quoted again, so that previously filled quantities are not bought or sold twice.
19. As a four-leg trader, I want temporary book failures to pause quoting while preserving my resting maker, so that a market-data outage alone does not discard its queue position.
20. As a four-leg trader, I want quoting to resume when valid book data returns, so that a temporary failure does not require a new deal.
21. As a four-leg trader, I want the deadline enforced even during a book outage, so that an outage cannot extend the maker window.
22. As a four-leg trader, I want remaining quantity completed by taker after the deadline and confirmed cancellation, so that the strategy can finish without further maker waiting.
23. As a four-leg trader, I want unresolved orders probed rather than guessed or resent, so that an ambiguous response cannot duplicate my trade.
24. As a four-leg trader, I want restart to retain the deadline and consumed reprice count, so that restarting cannot reset execution limits.
25. As a four-leg trader, I want the waiting deadline, reprice usage and pause reason visible in the deal view, so that I understand what the execution is doing.
26. As a four-leg trader, I want to retain existing stop, convert and explicit reprice controls, so that I can intervene in an automated trade.
27. As a four-leg trader, I want manual commands to take precedence over automatic repricing, so that automation cannot reverse my intervention.
28. As a four-leg trader, I want a terminal report based on confirmed venue fills, so that completion is reported honestly even when the venue refuses a remainder.
29. As a four-leg trader, I want the local-book freshness limitation stated accurately, so that successful fetching is not presented as proof of the source book's age.
30. As a four-leg trader, I want the chosen simplifications preserved, so that funding forecasts and additional basis checks do not silently block the trade.

## Implementation Decisions

- 范围：仅对明确来自四腿建仓后永续对冲流程的新 deal 启用。通过交易意图明确标记策略，不根据交易所名称、标的或当前账户持仓猜测范围。普通永续双腿、单腿、平仓和已有 deal 保持原策略及已保存期限。
- 复用已有 deal 创建、执行循环、纯决策器、订单账本、交易票据和交易进度视图。不创建第二个执行器，不由前端计时器直接撤单或下单。
- 保持单写者执行循环及每 tick 至多一个 venue mutation。决策器只接收意图、投影、时钟值和观测结果，不访问网络、真实时钟或随机数。
- 首次 maker 交易所选择继续比较两种 maker＋taker 手续费率组合，平局默认多头；执行中不自动交换 A／B 的 acquire／hedge 角色。
- 新策略的自动报价目标是真正的同侧最优价：BUY 使用 best bid，SELL 使用 best ask。不得全局修改旧策略的“同侧最优价之外一个价差”行为。
- 买卖价格按当前 venue tick 与精度限制安全格式化；保持 post-only。格式化后不能形成合规 resting 报价时不盲目挂单。post-only 拒绝按现有拒绝与退避逻辑处理，不因此直接转 taker。
- 自动改价仅处理“落后”：BUY 的当前挂价低于 best bid，或 SELL 的当前挂价高于 best ask，距离至少两个合约 tick。差值不足两个 tick、刚好处于同侧最优价或挂价更积极时，不仅为追随盘口而撤单。
- 自动改价还要求距上次 maker 挂单至少十五秒，并且尚未消耗二十次自动改价额度。网络查询本身不消耗额度。
- 每个自动撤单重挂周期计一次额度；在首次发起该周期前持久化记录，重试撤单、处理未知结果和重启恢复不得重复计数。初次挂单以及现有 post-only 拒绝重试预算与自动改价计数区分，不能借助重试无限规避上限。
- 单个改价周期遵循：发起撤单，确认原单不再可能继续成交，核对最终累积成交，先处理新增成交的可提交对冲数量，再为未成交且未被订单预留的剩余数量挂新 maker。沿用现有最小数量、名义金额、数量步长及 dust 报告规则。
- 已确认成交部分及时以 taker 对冲，不等待全部 maker 成交，也不把第二腿改成 maker。无法确认订单状态或无法安全提交对冲时，使用现有冻结、退避、停止继续获取敞口及告警规则。
- 二十次自动改价额度耗尽后，保留最后报价至成交、手动操作或绝对期限。次数耗尽本身不触发 taker 转换。
- 默认等待期限为三十分钟，从永续 deal 创建时间计算。下单前可通过现有等待时长输入调整；创建校验应接受三十分钟默认值，前后端保持一致。最小／最大合法取值沿用兼容的现有限制；若现有限制不接受新默认值，只做支持默认值所必需的调整，不新增未经讨论的时长政策。
- 期限一经创建即持久化；改价、部分成交、盘口异常、UI 重新挂载和进程重启均不重置。到期判断优先于自动改价和市场数据暂停，且现有显式 stop／halt 等安全状态仍有原优先级。
- 到期进入现有 converting 流程：撤销剩余 maker，确认最终成交，补齐已成交部分的对冲义务，再以 taker 获取剩余 A 数量并对冲。不得越过 pending、quarantine、未知撤单结果或可提交数量校验；三十分钟不是全部成交的保证。
- 新策略下，自动报价依赖本地成功获取的可用盘口，复用现有一秒价格缓存。价格必须为有效正数，并符合可用、非交叉买卖盘要求。请求失败、过期本地缓存不能刷新为新鲜、无法解析或无有效双边盘口时，返回不可报价结果，不将缺失值当成零或使用旧价格进行新的自动报价。
- 本地标准不验证交易所源盘口时间戳；成功请求或本地解析时间不得被描述为“源盘口一定新鲜”。本次不新增源时间戳协议或外部行情源。
- 单纯盘口异常时暂停新增 maker 和自动改价，保留未撤销的现有 maker。它仍可能成交，循环须继续观察订单并处理已确认成交的对冲。此要求不覆盖订单状态不确定、对冲失败、手动 stop／convert、halt 或其他现有必须撤单的安全条件。
- 如果一个改价周期已发起撤单后才发生盘口异常，不试图恢复原单；确认撤单并履行已有成交的对冲义务后，等待有效报价再重挂。
- 数据恢复且未到期时继续原 deal；已到期时进入 converting，不重新开启 maker 窗口。
- 新策略使用自动报价，但已有固定价格／用户显式改价命令的含义不能被自动刷新覆盖。手动 stop、convert、reprice 的既有优先级、幂等性与权限要求保留；手动固定报价后不自动追价，除非用户通过既有命令明确恢复自动跟随策略。
- 增加最少必要的持久化策略配置和自动改价进度；旧账本可兼容打开，历史订单、成交、期限及状态不得改写或重新解释。保存格式与字段命名由实现者决定。
- deal API 负责传递和校验配置，返回可解释的执行进度；路由保持薄意图写入层，UI 不代替引擎执行订单操作。显示绝对期限／剩余等待、已消耗自动改价次数、暂停原因及当前阶段。
- 不读取资金费率或下次结算时间来限制等待与改价；删除此前讨论但已撤回的“maker 节省手续费 50%”资金费损失预算。本次不加入双腿入场基差或额外经济性追价检查。已有账户、保证金、权限、订单状态及交易执行校验保持不变。

## Testing Decisions

- 用户已确认测试边界：以已有 deal 引擎模拟器为主，通过假交易所、可控时钟和真实订单账本证明行为；只补充 API 参数和 UI 范围隔离测试。
- 采用尽可能高的已有入口驱动完整 observe → project → decide → act 循环，观察 venue 调用、订单成交、持久化状态、进度视图与最终报告。不要仅测试某个 helper 返回值或复制实现表达式。
- 先例包括现有 FakeVenue、VirtualClock、write-ahead 后崩溃注入、逐步 invariant 检查、诚实终态报告，以及通过 API 注入创建 deal 再手动驱动同一循环的离线测试。优先扩展这些 seam，不建立独立策略测试引擎。
- 仅在必要时扩展 fake venue 的双边盘口及获取失败观测，使用同一可控时钟验证时长；为新持久化字段增加文件账本重开测试，不能仅依赖内存对象模拟重启。
- 验证 BUY／SELL 初始报价分别为同侧最优价且 post-only，tick 格式化与现有 Hyperliquid 精度限制有效；普通双腿、单腿、平仓与已有 deal 不启用新默认。
- 验证改价边界：不足两个 tick 不改、刚好两个 tick 可改；十五秒之前不改、到达十五秒可改；挂价更积极不为跟随而撤单。
- 验证先确认撤单再重挂；撤单期间新增成交只对冲一次，重挂数量不含已成交或已预留数量；无超额 acquire、无超额 hedge、无重复 client id 提交。
- 验证 partial fill 后优先市价对冲，全部目标达成即完成，不等待三十分钟；dust 或交易所拒绝按原逻辑如实报告。
- 验证二十次上限、网络观测不消耗计数、未知撤单重试不重复消耗、重启不重置计数；耗尽后保留最后 maker，不提前 converting。
- 验证默认三十分钟与下单前修改的时长；期限不因部分成交、改价、异常或重启重置。覆盖到期与改价条件同 tick，以及先有手动 stop 的优先级。
- 验证有效盘口缓存、获取失败、无效价格、交叉／单边盘口等情况；仅盘口异常时原 maker 保持有效，没有新增 maker 或改价，订单观察及必要对冲继续运行。
- 验证已发起撤单后盘口失败：没有未知状态下的补挂，也不重新创建已撤原单；有效数据恢复后按原期限继续。
- 验证盘口异常期间到期仍请求撤单，确认最终成交后进入原 taker 完成路径；无法确认订单或安全确定提交数量时不猜测、不重发。
- 验证 manual stop／convert／fixed reprice，以及 pending、quarantine、hedge wall 和 halt 等现有安全行为没有因“盘口异常保留原单”被绕过。
- API 测试覆盖四腿策略显式标记、参数合法性、默认值、幂等创建、进度暴露及旧输入兼容。UI 测试覆盖四腿票据传播策略与等待设置、普通交易不带新策略，以及交易视图的期限／计数／暂停说明。
- 验证无需资金费率、结算时间或基差检查输入即可执行新策略，且不得因此删除已有通用交易校验。
- 实现验收运行仓库规定的离线验证、相关 UI 测试与生产 web 构建。默认不运行会下真实订单的 live 测试，不以本次规格发布或离线通过声称真实 maker 成交率已经提高。

## Out of Scope

- 修改 Boros 的报价、下单、原子批量、展期或成交恢复机制。
- 改造首次 maker 交易所选择算法，依据流动性／成交概率重新选择 venue，或在执行中切换 acquire／hedge 角色。
- 两条永续都挂 maker；延迟对冲已确认 maker 成交。
- 全局改变普通双腿、单腿限价、平仓及存量 deal 的报价／等待行为。
- 资金费率与结算时点驱动的等待边界、资金费损失预算、双腿入场基差检查、额外经济性追价上限。
- 源盘口时间戳验证、新行情来源、WebSocket 成交推送、连接池优化或整体对冲延迟改造。
- 新的用户可调改价频率／tick 阈值／次数上限；本次采用已确认的固定默认，等待时长保留现有下单前调整能力。
- 无限改价、不断重置期限、因 post-only 拒绝直接转换市价，以及弱化订单未知结果处理。
- 本工单发布时修改交易执行代码、真实下单、服务重启、合并或部署。

## Further Notes

- 2026-10-11：用户在 grilling 对话中逐项确认参数，明确撤回资金费相关约束和基差检查，并确认最终设计；随后使用 to-spec 要求发布规格。测试 seam 已单独得到用户确认。
- 三十分钟是 maker 等待窗口，不是成交、风险损失或最终成本上限。允许跨资金费结算及追价改变入场成本，这是用户已接受的取舍。
- Boros 的 mark implied APR 浮盈亏与清算风险不会等资金费结算才变化，永续资金费对冲也不直接消除该风险。本规格不承诺资金费过覆盖或等待风险小，也不将本地可用盘口视为账户适用性或执行可行性的充分证明。
- 改价次数与时间应是同一 deal 的持久化事实，不能存放为前端组件状态。继续使用现有 venue truth／intent ledger 分工，不新增平行恢复状态机。
- 实施时若发现协议或现有引擎无法满足撤单确认、对冲优先或范围隔离，应记录具体阻碍；不得通过更改本规格的已确认约束来绕过。
