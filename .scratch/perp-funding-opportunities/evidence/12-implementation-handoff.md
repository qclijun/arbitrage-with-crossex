# 工单12实施交接

目标：[执行契约](../preflight-and-execution.md)中服务端预览、最终准入与幂等。用户确认接缝（2026-10-28）：预览变化按用户可见精度比较（共同币种金额2位、回本天数1位；参数、费率、借款/换汇状态、警告逐字）；杠杆由engine设置；FX同计价不换算、USDT/USDC混合用新鲜Gate现货USDC_USDT双向明示，否则UNKNOWN；借款无负债且保证金足够为不适用，已有负债按负债×日利率计入，否则UNKNOWN；保证金失败即阻断（确认杠杆下初始保证金＋两腿taker费≤可用）；交易权限以签名账户/杠杆读取成功为证，并在预览风险提示中明示此限制。历史缓存与CrossEx符号↔(venue, contractId)映射是可选AppDeps端口，缺失即拒绝。

## 交付

- **engine自有杠杆**（`src/engine/leverage.ts`，账本第4步`pair.leverage_json`）：deal带每腿目标杠杆时，engine在任何价格读取及下单前逐腿处理，每tick至多一次`setLeverage`，先读后设、写前记录原值、设后读回确认；已一致则不发请求。拒绝、读不到、未知且读回不符→deal以写明原因结束，不下任何单；已设的腿只报告“not restored”，不自动恢复，读回为第三值时注明“left changed”。STOPPING/HALTED不再设杠杆；到期不越过未确认杠杆转taker。`VenuePort`新增`setLeverage`/`readLeverage`（Gate适配器三分类，仅杠杆/坏请求类4xx标签算确定拒绝）。旧`POST /deals`的路由内设杠杆未改（架构文档注明为既有例外）。
- **意图账本**（账本第5步`funding_intent`，`src/engine/funding-intents.ts`）：意图id、业务指纹、所消费预览（唯一）、候选、deal、切片、确认内容、接受时间。`DEAL_PURPOSES`加入`funding-two-leg`（`POST /deals`仍拒绝该用途）。`ledger-support.json`升至5。
- **预览**（`POST /api/funding/preview`，`src/server/funding/`）：`request.ts`严格解析（maker腿、两腿整数杠杆必填；timeout默认300、30–3600整数，越界400不夹值；十进制≤12位）。`evidence.ts`一轮只读取证（`readAt`为读取开始）：历史`recheck`、规则、杠杆上限/当前值、费率与盘口（11的`readCostEvidence`）、账户、利率、持仓、挂单、FX（须带场所自身时间且距读取≤10秒）。`judge.ts`＋`sizing.ts`＋`gates.ts`纯判定：准入开关、历史、符号映射、白名单/同单位、lot公共步长向下取整（展示原因）、min/max/最小名义、maker价（未给则取同侧最优并按tick远离穿价）、费率、杠杆上限、FX、借款、持仓冲突（活动deal、挂单、反向仓、未归属同向仓、未对账/有未归属量的切片合约）、情景UNKNOWN（含深度不足）、保证金。`content.ts`产出确认内容；有阻断时`previewId`为null，仍可观察。预览内存登记，`expiresAt=readAt+10s`，绑定准入代次。
- **接受**（`POST /api/funding/intents`）：同id同指纹→原回执（200、`duplicate`），同id异内容→409；未知预览、未授权转换、未确认风险、内容哈希不符、带阻断、已被消费→409且不读取场所；`now≥expiresAt`→409并附新预览。其后完整重读并重判：读完已超原预览或本轮10秒、出现阻断、内容变化→409并附新预览。最后在`admission.admit(代次)`事务内无await复核意图id/预览/活动deal，原子写切片（`funding-two-leg`，基线为本轮读数）、deal（maker腿为A，固定价，deadline=接受时刻+timeout，MARKET IOC无价格带，杠杆目标pending）、attach与意图记录，然后wake。路由不调用任何场所写接口。
- **回执**（`GET /api/funding/intents/:id`）：确认内容＋deal当前mode/累计成交/未对冲/报告/杠杆状态/原deadline，终态照常可查；未知id 404。

## 验收映射

10秒边界（恰好10秒拒、9.999秒受理）、重读跨过期、跨UTC整点（cutoff变化→拒绝）、证据变化（费率变→新预览；FX盘口小跳动不改状态→仍受理）、UNKNOWN/NaN费率/盘口缺失/深度不足/各项读取失败、FX无时间或陈旧、已有负债计入与无法定价阻断、反向仓/未归属同向仓/挂单/活动deal、同向可对账切片可共享、同id并发同内容（一个deal、一个202一个200）及异内容（一个deal、一个409）、已消费预览与关开准入后旧预览不能复活、回执覆盖终态且deadline不变、失败准入无场所变更、杠杆单writer每tick一变更、转换未授权/风险未确认拒绝、无历史端口503不回退普通pair。

## 审查

双轴审查。规格轴：FX/借款的具体汇率与本金进入确认内容会使盘口跳动/利息累积永远“已变化”（改为只比状态，金额效应已在2位金额中）；同为USDC两腿仍需FX（改为共享计价即为计算币种）；保证金多乘1.05缓冲（按约定公式去除）；FX以读取开始盖时间（改用场所返回时间并校验≤10秒）；补已有负债测试；读回为第三值未明示（已补）。标准轴：规则值与FX取倒数经浮点（改为纯十进制/精确有理数）；路由手写成功信封（改用`reply.ok`，拒绝附新预览经`refuse`扩展参数）；长行、命名（`again`/`dec`/`current`）、重复409、杠杆相等两套比较、来源字段重复、`app.ts`内联类型导入、`judge`过长（拆出`sizing.ts`/`content.ts`）均已改。`leverage.ts`纯判定与IO同文件沿用`hedge-wait.ts`先例未拆。

## 验证

新测试：`tests/unit/engine-leverage.test.ts`（9）、`venue-gate-leverage.test.ts`（2）、`funding-intents.test.ts`（2）、`funding-reads.test.ts`（1）、`tests/server/funding-preview.test.ts`（25）、`funding-accept.test.ts`（12）、`funding-intent-races.test.ts`（6）；夹具`tests/helpers/funding-intent-fixture.ts`。审查前默认`yarn verify`退出1：root 3505/8跳过全过，web仅`App.setupOnce`既有偶发失败（主机负载≈20，web未改动；`/tmp/t12/verify.log`），web build退出0。审查修复后默认`yarn verify`退出1：tsc与文件预算通过，root 3509/8跳过全过；web 2/1730失败——`App.setupOnce`及`PairTicket`重挂载5秒超时，均为既有偶发项（web未改动，主机负载≈15–20；`/tmp/ticket12-verify2-fail.log`），单跑两文件27/27通过（仅诊断，不替代全量结果），归21查因。web build退出0。

## 限制

- 生产端未接线：历史缓存与符号映射端口由18接入；未接时路由503。页面（13）及持久提交/恢复（14）未做。
- 账户、持仓、杠杆、费率等签名读取无场所时间，以本轮读取开始时刻为证据时间（实时请求、不经缓存）；仅FX盘口有场所时间可校验。公共盘口沿用11的时间戳。
- 交易权限仅由签名读取成功推断；无交易权限的密钥要到首单才暴露（预览已列为确认风险）。
- 16的Risk豁免不在准入中另读：准入只用同源的15对账（同向共享须全部数量归属切片且对账），确认风险中列明“只豁免已对账浮动数量”。
- 保证金以共享计价（USDC两腿时为USDC）与账户可用保证金直接比较，未换算USD。
- deal的maker等待从接受时刻起算，含engine设杠杆的数个tick。
- 预览仅存内存：重启后未接受的预览全部失效，只能重新预览；已接受意图由账本恢复。
