# 单次 Opportunity 收益候选筛选

脚本只消费当前终端的 Opportunity 计算，分别查询平仓与滚仓，默认最多展示十个收益候选（可用 `--top` 调整）。它不读取账户、持仓、钱包或保证金，也不下单、通知、启动监控或启动服务。运行前终端需已由用户启动；离线测试仅使用合成数据，不执行交易。

报告中的成交利率、利差、模型资金、净收益、杠杆及 OI 字段见[字段说明与计算公式](opportunity-screening-fields.zh-CN.md)。

```sh
python3 scripts/opportunity_screening.py \
  --url http://127.0.0.1:6688 \
  --token-file /path/to/api-token \
  --notional 10000 --top 10 \
  --max-friction 0.4 --min-profit-ratio 0.001 \
  --output-dir data/opportunity-screening
```

无需额外 Python 包；使用支持 `zoneinfo` 的 Python 3.9+。token 仅从文件读取，不能作为明文命令行参数传入。先验证本机 URL，再读取 token；仅允许 loopback origin，不接受 URL 内认证、路径、查询或片段。localhost 固定到 127.0.0.1，环境代理关闭，重定向拒绝。正常运行依次发送两次 GET `/api/opportunities`，各带 `entryMode=maker-hedge`、`borosEntry=market`、`exitMode=close/roll` 和规模；遇 401/403 立即终止，不再继续请求。不另建行情采集器。

| 参数 | 默认值 | 含义 |
|---|---|---|
| `--url` | `http://127.0.0.1:6688` | 终端 loopback origin |
| `--token-file` | `api-token` | 本机鉴权文件；不写入报告 |
| `--notional` | `10000` | 每腿 USD 名义本金 |
| `--top` | `10` | 最多展示数量；不足不补齐 |
| `--output-dir` | `data/opportunity-screening` | 每次生成独立运行目录 |
| `--max-market-age` / `--max-age` | `180` | 最大行情观察与构建年龄，秒；旧参数保留为别名 |
| `--max-static-age` | `600` | 最大手续费、合约规则和杠杆限制观察年龄，秒 |
| `--max-skew` | `120` | close/roll 行情观察时间偏差上限，秒 |
| `--timeout` | `20` | 每次请求超时，秒 |
| `--max-friction` | `0.4` | close 成本摩擦比例上限，必须严格小于；0.4 = 40% |
| `--min-profit-ratio` | `0.001` | close 最低净利润占每腿名义本金的比例，必须严格超过；0.001 = 0.1% |

金额以 USD 数值保存；JSON APR 为 decimal fraction（`0.05` = 5%），Markdown 为百分比。时间以 Asia/Taipei 展示，输入观察时间 JSON 字段为 Unix 毫秒。每次输出来自同一规范化结果的 `report.json` 与 `report.md`；运行目录权限 0700、文件 0600。不会覆盖旧运行。写入失败可能留下不完整目录；退出码 1，不宣称双格式完成。

| 退出码 | 含义 |
|---|---|
| `0` | 完整有效扫描，包含零候选和正常准入门槛过滤 |
| `2` | UNKNOWN、关键证据缺失或部分结果；保存降级报告 |
| `1` | 参数/鉴权错误、无法开始采集或写入失败 |

## 1. 候选来源与固定请求口径

1. 输入是两份 Opportunity 响应的 `data.groups[].pairs[]`，分别按 close、roll 处理。脚本遍历所有组中的所有组合，不只读取 `bestPair`，也不沿用服务端已有排序作为最终排序。
2. 两次请求使用同一 `notionalUsd`，固定 `entryMode=maker-hedge`、`borosEntry=market`；close 为主榜，roll 仅作同组合对照。请求不带 `fresh=1`，复用终端现有缓存，并检查返回的观察时间。
3. 上游 Opportunity 当前只接纳 ETH、HYPE、BTC；按抵押品 `tokenId`、到期日、归一化标的分组。只有状态为 `Normal`、尚未到期的市场参与分组，少于两个市场的组不输出。
4. 当前 `borosEntry=market` 下，上游仅生成 short 市场 `midApr` 严格大于 long 市场 `midApr`、且两侧 `crossexVenue` 不同的有向组合。有 CrossEx 场所映射但缺确认合约的市场仍可能产生组合，交由后续证据检查降级；完全没有场所映射的市场不参与配对。
5. `--top` 必须是正整数；名义本金、两类最大年龄、最大偏差、请求超时必须是有限且严格大于零的数值。`--max-friction` 必须有限且严格大于零，`--min-profit-ratio` 必须有限且非负；后者与名义本金的乘积必须有限，且正比例不能乘得零。设为零恢复严格正净利润门槛，仍保留 friction 门槛。参数检查在读取 token 和发送请求前完成；脚本没有设置这些参数的额外上限。

## 2. 每份响应的公共证据检查

本节按 close、roll 分别执行。公共检查失败会进入该口径的错误列表，并使依赖这些错误检查的组合标为 UNKNOWN；close 的失败不由 roll 替代。

1. 响应必须是对象，`ok` 必须严格为 `true`，`data` 必须是对象。外层 `meta`、`data.meta` 若提供，必须是对象；缺省时按空对象处理，仍须通过后面的必需字段检查。`data.groups` 必须是数组。
2. 本文的“有效数值”与代码 `number()` 一致：只接受有限的整数或浮点数，拒绝布尔、字符串、`null`、NaN、Infinity，以及无法转为有限浮点数的超大整数。数值比较不采用四舍五入或近似相等。
3. 分别检查 `data.meta.freshness.marketData/staticData`：观察时间 `observedAt` 必须是有效数值，单位为 Unix 毫秒；`stale` 必须明确为 `false`。观察年龄按两次采集结束后的同一时刻计算：`扫描时刻 − observedAt / 1000`。
4. 年龄小于零（未来时间）或严格大于对应上限时 UNKNOWN；等于上限允许。行情上限默认 180 秒，静态上限默认 600 秒。任一分类缺失、超龄或 stale，都会使该口径的组合无法准入。响应 `ts` 和构建时间不能替代分类观察时间。
5. 外层 `meta.observedAt` 必须是有效数值且不晚于扫描时刻；两类观察时间都有效时，必须严格等于两者最小值。此处不单独对聚合时间应用 180 秒年龄门槛，也不把一致性校验当作独立上游验证。
6. `meta.stale`、`data.stale` 若缺省按 `false`；`meta.coverageComplete` 若缺省按 `true`。实际值必须分别严格为 `false`、`false`、`true`，否则该口径的组合 UNKNOWN。分类 `stale` 没有这个缺省兼容行为。
7. `data.meta.asOfSec` 必须是有效数值，不在未来，构建年龄不超过行情年龄上限；还须满足 `asOfSec × 1000 + 1000 >= meta.observedAt`，即允许构建时刻按秒取整造成最多 1 秒差异。等于边界允许。
8. 返回的 `data.meta.notionalUsd` 必须是有效数值且严格等于请求规模；`entryMode`、`borosEntry` 必须分别等于 `maker-hedge`、`market`，`exitMode` 必须等于正在处理的 close 或 roll。任一不符，按请求假设错配处理。
9. 公共告警按下一节检查；即使数值完整，也不能绕过公共告警的 UNKNOWN 判定。

服务端分类元数据取该类已取得输入的最旧时刻，合并该类 stale 状态：行情类包含 Boros 市场/盘口和永续盘口，静态类包含手续费、合约规则和杠杆限制。整类没有取得观察时间时为 `null`。服务须加载支持分类字段及机器告警的代码；脚本不会自动重启服务。

## 3. 告警如何影响准入

1. 根响应和每组的 `warnings` 若缺省按空数组；提供时必须是字符串数组。`warningEvidence` 若缺省按空数组；提供时必须是对象数组，且项数与对应 `warnings` 相同。格式或项数不符时 UNKNOWN；因此旧服务“没有告警”可兼容，“有文字告警却没有机器证据”不可兼容。
2. 根响应存在非空且格式有效的机器告警时，该口径的组合全部 UNKNOWN。只要其中任一项的 `code` 为 `assumed-fee-schedule`，原因记为假设费率，并在排除项中保留有限的收益/成本值作为 `reference`；其他情况记为来源或费用证据待核查。参考值不进入候选榜。
3. 组级告警只有以下两种情况能确认市场作用域：`marketId` 为整数，能在该组找到对应整数 ID 的市场；且 `unsupported-perp-venue` 对应市场无 `crossexVenue`，或 `missing-perp-symbol` 对应市场有 `crossexVenue` 但无 `crossexSymbol`。
4. 对作用域已确认的告警，只排除 short 或 long 腿使用该 `marketId` 的组合；未使用该市场的完整组合可继续准入。
5. 组级其他代码（包括 `collateral-price-unavailable`）、缺失/错误市场关联、与市场字段矛盾的代码，一律作为未能限定作用域的组级问题，使该组组合 UNKNOWN。
6. 脚本不匹配英文 warning/reason 模板。盘口失败具体腿从安全的 `venueBookFailures.symbol` 关联，费用缺失从成本字段判定；这些具体原因在组合已经被排除时补充展示。诊断列表和原始 `pair.reasons` 本身不是独立的候选过滤条件。

## 4. 每个组合必须通过的检查

close 和 roll 使用相同的结构、数值证据检查；下一节的 friction 与最低净利润门槛仅用于 close。

1. 组必须是对象且 `markets`、`pairs` 均为数组；组合必须是对象。畸形组被跳过并记录口径级错误。按当前顺序处理实现，该错误会参与后续组合检查，已经收集的候选不会追溯删除；整体报告仍为 UNKNOWN。
2. `underlying`、`collateral` 以及腿内 `venue`、`crossexVenue`、`crossexSymbol`、`base` 必须是长度 1～48、符合 `[A-Za-z0-9_.:+-]` 的字符串。组 `tokenId` 和腿 `marketId` 必须为整数，组 `maturity` 必须为有效数值；这里未另设 ID 必须为正的检查。
3. 每份响应内按组合身份查重；重复身份的后出现项 UNKNOWN，第一项不追溯删除。身份元组及其字段顺序见排序一节。
4. `shortLeg`、`longLeg` 必须存在且为对象。按腿的 `marketId` 在该组 `markets` 中查找首个匹配市场；该市场 `bookStatus` 必须严格等于 `ok`。缺市场、盘口不可用或深度不足均 UNKNOWN。
5. 匹配市场的 `crossexVenue`、`crossexSymbol` 必须分别与腿内字段严格相等。short 腿 `execApr` 与市场 `execShortApr`、long 腿 `execApr` 与市场 `execLongApr` 必须分别为有效数值且严格相等。
6. `costs` 必须是对象，下面八个字段全部为有效且大于等于零的数值：

   ```text
   borosTakerFeeUsd, borosSettleFeeUsd,
   perpEntryFeesUsd, perpEntrySlippageUsd,
   perpExitFeesUsd, perpExitSlippageUsd,
   totalUsd, annualizedApr
   ```

7. `capital` 必须是对象，四项保证金均为有效且大于等于零的数值；两项最大杠杆必须有效且严格大于零：

   ```text
   borosShortImUsd, borosLongImUsd, perpShortImUsd, perpLongImUsd,
   shortLeverageMax, longLeverageMax
   ```

8. 下面九个组合字段必须全部为有效数值；其中 `capitalUsd`、`secondsToMaturity` 还必须严格大于零：

   ```text
   grossSpreadApr, execSpreadApr, borosImpactApr, capitalUsd,
   netFixedApr, netFixedAprOnCapital, effectiveLeverage,
   estProfitUsd, secondsToMaturity
   ```

9. `makerLeg` 必须为 `short` 或 `long`。它表示已有模型选择的 maker 腿；脚本不自行重新选择 maker。
10. 组 `secondsToMaturity` 必须为有效数值且严格等于组合对应值；还须满足 `abs(maturity − asOfSec − secondsToMaturity) <= 1`，单位为秒。
11. 组级告警必须通过上一节的作用域检查。若以上任何检查失败，组合保存为 `excluded[].status=UNKNOWN`，附原因及可定位的无效字段，不进入该口径的有效组合列表。
12. 通过以上检查后，计算 `holdingPeriodReturn = estProfitUsd / capitalUsd`；商仍必须为有效有限数值，否则 UNKNOWN。

## 5. close 准入门槛与滚仓对照

1. **仅 close 主榜执行以下两条门槛，必须同时满足。** 通过前述证据检查后，以每腿名义本金 `N = notionalUsd`、剩余年数 `T = secondsToMaturity / (365 × 86400)` 计算 `grossProfitUsd = grossSpreadApr × N × T`，再计算 `friction = costs.totalUsd / grossProfitUsd`。要求 `friction < --max-friction`（默认 0.4），且 `estProfitUsd > N × --min-profit-ratio`（默认 0.001，即 0.1%）。等于任一边界也过滤；每腿名义 $10,000 时要求净利润严格大于 $10，最低利润不再按期限折算。

   `grossSpreadApr` 是中间利率差，不是 `execSpreadApr`；毛利润尚未扣除 Boros 盘口冲击和模型费用，不能以 `estProfitUsd + totalUsd` 替代。分子直接使用 close API 的 `costs.totalUsd`，不另加已体现在成交利率中的 Boros 冲击。

   未达门槛记为正常 `FILTERED`；两条都不满足时记录两项原因。有限的毛利润小于等于零时，friction 无定义，保存为 `null` 并过滤。毛利润计算非有限、正利差计算毛利润下溢为零、或 friction 非有限，均为 UNKNOWN。前述证据错误优先按 UNKNOWN 处理，不以收益过滤掩盖。
2. **roll 不执行这两条准入门槛，也不派生 `grossProfitUsd` 和 `friction`。** 通过证据检查的零利润、负利润或高成本 roll 仍可作为 VALID 对照展示，用来说明该口径的实际模型结果；不会单独触发 UNKNOWN。
3. close/roll 必须按完整组合身份严格匹配，包括标的、抵押品、tokenId、到期日、short/long 市场及各侧确认合约。方向交换视为不同组合。
4. 比较两份响应外层 `meta.credentialId` 的实际值；不相等时对照 UNKNOWN。两边都缺失时均为 `None`，当前代码视为相等，不额外查询或证明账户身份。
5. 两份响应的 `marketData.observedAt` 必须均为有效数值，且绝对偏差不超过 `--max-skew × 1000`，默认 120 秒；等于边界允许。比较不用静态时间或聚合时间。
6. 每个有效 close 组合只在有效 roll 列表中查找同身份项。不存在匹配项、roll 有口径级公共错误、身份范围错配、行情偏差超限或缺时刻，均使该 close 的 `roll.status=UNKNOWN`。有匹配项时，`makerLeg` 还必须与 close 完全一致。
7. 对照异常保留独立有效的 close 主榜项，不改其 close 数值和排序。无效 roll 组合不会按合约名、接近的到期日或近似规模替代匹配。
8. 只有 roll 出现而 close 没有有效项的组合，不补进主榜；同一组中其他 roll 组合的单项错误不会自动使本组合对照 UNKNOWN，但会使整体数据状态 UNKNOWN。

## 6. 最终排序与 Top 截取

完成 close 证据检查、两条准入门槛过滤和 roll 对照关联后，对所有有效 close 组合做一次全局排序。优先级严格如下，只有上一项完全相等才比较下一项：

| 优先级 | 字段 | 方向 |
| --- | --- | --- |
| 1 | `netFixedAprOnCapital`：模型资金净年化 | 降序 |
| 2 | `netFixedApr`：每腿名义本金净年化 | 降序 |
| 3 | `execSpreadApr`：成交利差 | 降序 |
| 4 | 完整 `identity` 元组 | 按下列字段顺序作字典序升序比较 |

```text
identity = (
  underlying, collateral, tokenId, maturity,
  shortLeg.marketId, longLeg.marketId,
  shortLeg.crossexVenue, shortLeg.crossexSymbol,
  longLeg.crossexVenue, longLeg.crossexSymbol
)

排序键 = (-netFixedAprOnCapital, -netFixedApr, -execSpreadApr, identity)
```

1. 使用 API 原始数值排序，不先按显示精度取整；字符串按 Python 字符串字典序比较，不做本地化或大小写折叠。
2. 排序后取前 `--top` 项，默认 10；不足时全部保留，零候选不补齐。
3. 不直接按 `friction`、`grossProfitUsd`、`estProfitUsd`、`grossSpreadApr`、OI、期限、总成本或 roll 收益排序，也不因对照 UNKNOWN 而将 close 候选降序。
4. 没有按币种、到期日或共享市场设置名额，也没有组合分散化、资金分配或“最多选择一个相似组合”的步骤；多个候选可能使用同一市场。
5. 服务端配对时的排序还含 `grossSpreadApr` 并列键，但脚本最终重排使用上面的四项规则，不保留该并列键。

## 7. 整体状态与单项状态

1. 出现任一请求失败、close/roll 口径级错误、范围/时间对照错误、任一 close/roll 排除项为 UNKNOWN，或任一有效 close 的 roll 对照 UNKNOWN，整体 `status=UNKNOWN`；成功保存报告后退出 2。
2. 此状态检查覆盖完整有效 close 列表及两种口径的排除项，不只覆盖 Top。榜外 roll 对照异常仍保存到 `comparisonIssues`，注明全局排名、是否在 Top 和原因；Markdown 同时展示。
3. 整体 UNKNOWN 不表示 Top 中每一项都无效。允许同时保存有效 close 候选和其他组合的错误，不为凑满 Top 而放宽准入。
4. 没有上述问题时整体 VALID，成功保存报告后退出 0；包括合法零候选、候选不足 Top，以及只有正常准入门槛 FILTERED 的情况。
5. 两次请求全部失败、参数或鉴权失败、报告写入失败等启动/保存错误退出 1。仅一份响应成功时仍尽可能保存降级报告；roll 不替代缺失的 close 主榜。
6. `assumptions.feeEvidence` 当前只根据 close/roll 的口径级错误列表设置，不是每个排除项或费用来源的独立核验结果，不能用它覆盖整体或单项 UNKNOWN。

## 8. 当前没有执行的附加筛选或验证

1. 除第 5 节的 close friction 和最低净利润门槛之外，没有额外的固定最低净利润金额、最低 APR、最低执行利差、最低 OI、最大杠杆或最短/最长持有期限门槛。相关字段仍须通过前面的有限性、非负性或正值检查。
2. OI 仅为参考：缺失、非有限或负值在报告中写 `null`，不会因此排除候选。`oiUsd` 按组内市场顺序收集，不参与排序。
3. 脚本直接消费 API 的收益、成本和资金，不重新验证 `costs.totalUsd` 等于各费用之和、`capitalUsd` 等于四腿保证金之和，或各收益率满足模型公式；因此“字段完整”不等于独立复算通过。
4. 不依据原始 `pair.reasons` 文案准入，不独立重走永续盘口，不额外核验逐项上游费率来源、24 小时均值、趋势、历史回撤或未来续作收益。无告警只表示 API 没有声明该类问题。
5. close 额外派生第 5 节的 `grossProfitUsd` 和 `friction`；两种口径均派生持有期收益 `estProfitUsd / capitalUsd`、额外成本归零门槛 `max(0, estProfitUsd)` 及报告用 OI 数组；不叠加客户端返费，不重复扣除已包含在 Boros 成交利率中的盘口冲击。
6. 模型资金是收益分母，不是实际账户余额、安全预算或执行就绪证明。maker 入场和模型 maker 退出假设按 mid 成交，挂单不保证成交；book ok 不证明四腿都能成交。Gas、借款利息等未建模成本不在当前结果内。
7. roll 只省去本期永续退出成本，最终退出仍可能付费，也不保证后续机会存在。

## 9. 报告证据与传输说明

排除项包含标的、抵押品、到期、两侧市场及合约、原因和可定位的无效字段；旧服务没有盘口诊断时只提供字段级原因，不猜测具体网络来源。JSON 保留 close/roll 各自排除项，Markdown 合并内容完全相同的排除记录并标明口径。原始 warning/reason 不写入文件，报告使用固定原因并额外遮蔽实际 token/credentialId。

`assumptions.maxFriction`、`minProfitRatio`、`minProfitUsd` 保存本次准入设置；有效 close 和正常 FILTERED 项保存 `grossProfitUsd`、`friction`，JSON 比例仍用小数，Markdown 显示百分比。历史报告缺少这些字段时，不能据此认定已执行新门槛。

`evidence.closeObservedAtMs/rollObservedAtMs` 保留聚合观察时间；`closeMarketObservedAtMs/rollMarketObservedAtMs` 记录行情偏差检查实际使用的时刻，分别等于对应 `evidence.close/roll.marketData.observedAtMs`。

终端服务的公开交易所盘口、合约元数据和市场查询统一使用已有 `GATE_PROXY` 配置，例如 `.env` 中的 `GATE_PROXY=http://127.0.0.1:7899`。未配置时保留原有请求行为；代理失败仍视为缺失证据，不回退到另一条网络路径。脚本访问本机终端仍关闭环境代理。修改服务代码或配置后需重新加载终端服务。

公开行情通过支持 keepAlive 的代理连接池按目标站复用 HTTPS 隧道，元数据与盘口共享连接；切换代理配置会关闭旧连接池。单次请求仍为 2.5 秒超时，没有新增重试或后台采集，也不改变签名交易客户端。首次连接、连接被上游关闭或网络中断后仍需重新握手，可能超时并产生 UNKNOWN；连接复用只减少重复建连开销，不保证每次请求成功。

盘口失败的 HTTP 状态码、采集耗时、错误类别、阶段及观察时间由 `data.meta.venueBookFailures` 提供，脚本保存到两种报告。未取得 HTTP 状态时明确显示未记录，不把它猜作 HTTP 错误；详见[盘口失败诊断](venue-book-diagnostics.md)。新字段需要终端服务加载更新后的代码，历史报告无法补回这些信息。

合成示例：[有效报告](examples/opportunity-screening/valid.md)、[JSON](examples/opportunity-screening/valid.json)；[降级报告](examples/opportunity-screening/unknown.md)、[JSON](examples/opportunity-screening/unknown.json)。示例全部来自固定时钟和虚构 API 响应，金额仅用于演示，不代表当前市场。

离线检查：

```sh
python3 -m unittest discover -s tests/screening -v
```

规则实现依据：[筛选脚本](../scripts/opportunity_screening.py) 的 `number`、`identity`、`warning_evidence`、`group_warning_issues`、`freshness_evidence`、`normalize`、`run`；上游候选范围见 [Opportunity 路由](../src/server/routes/opportunities.ts)、[分组和配对模型](../src/core/boros/opportunities.ts)及[支持币种](../src/core/coins.ts)。规则描述以当前代码为准，不将未实现的筛选原则写成已执行条件。
