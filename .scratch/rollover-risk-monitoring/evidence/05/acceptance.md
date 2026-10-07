# #05 第一阶段验收证据

日期：2026-10-07，Asia/Taipei。范围仅为公开逐 market 流动性，不推进 06–10。

## 02–05 交付核对

| 票 | 已交付证据 | 本次复验 |
| --- | --- | --- |
| 02 | research/02-liquidity-contract.md、02-official-sources.md | 延续 YU、单边 OI、桶化 APR、best-50 与独立时钟；截图不是实时值 |
| 03 | GET /api/boros/liquidity；tests/server/boros-liquidity.test.ts | 18 项 API 测试通过，公开 GET /固定范围/部分失败/空书/缓存只读契约 |
| 04 | liquidity-metrics.ts；tests/server/boros-liquidity-metrics.test.ts | 12 项 API→指标测试通过，精确 YU、方向与窗口端点/覆盖/UNKNOWN |
| 05 | Liquidity 标签；BorosLiquidityPanel；页面测试与下列真实截图 | 4 项指标→HTTP envelope→页面测试通过；正常、部分失败、空侧、过期、失败保留与 market 切换 |

页面测试使用真实 marketInputs/bookInputs/calculateLiquidityMetrics 从离线原始市场/盘口产生指标，通过 MSW 的公开 HTTP envelope 输入页面；与前两行的真实 Fastify API 离线测试组成同一交付边界，未 mock 查询 hook 或计算函数。App.hiddenTabs.test.tsx 已加入新页，只在可见时轮询，隐藏页不预采集公开全集。

## 真实浏览器

Codex 内置真实浏览器；现有后端未加载新 route，首次返回 UNKNOWN 请求失败。未重启现有后端。临时只注册 borosLiquidityRoutes + TtlCache 的 loopback 服务 6689，为前端 8722 的该 GET 提供当前公开数据，其他既有页面保持原服务。临时入口与配置不交付，验收结束即停止；不加载交易、引擎、通知或监控入口。

- 宽屏 1280×900：documentElement.scrollWidth = 1280（滚动条出现时 1272），不超过 innerWidth=1280。
- 手机 375×812：documentElement/body.scrollWidth = 367，不超过 innerWidth=375；市场列表、诊断、展开来源证据均复核。
- 实际 market 197（Binance）→198（OKX）切换，所选 region 与标题随之切换，不累计或混合数量。
- [宽屏分组](wide-markets.jpg)、[宽屏诊断](wide-diagnostics.jpg)、[手机分组](mobile-markets.jpg)、[手机诊断](mobile-diagnostics.jpg)。公开截图仅保留市场区域；包含账户头部的来源展开截图不纳入公开材料。

## 官方公开只读对照

首次公开路由快照：统计采集 2026-10-07 15:59:22.211 +08:00；market 197 盘口采集 15:59:23.688 +08:00。32 个 UI-whitelisted、未到期 markets，1 页，独立统计/盘口时钟。该点 market 197 volume=512.738088 YU、单边 OI=1511.2964089075394 YU；桶化 bid=4.95%、ask=5.40%、Spread=45.00 APR bp。后续值已变动，不把本记录当当前风险证据。

官方 GET https://api-boros.pendle.finance/apis/v1/markets/by-ids?marketIds=197 于 2026-10-07 16:05:51 +08:00 完成：volume=512.730688 YU，单边 OI=1511.2964089075394 YU，与同期路由值相同。官方 market bestBid=0.049589137570152084、bestAsk=0.054006571631079595 是未聚合值；路由纯聚合书=0.0496/0.054，页面=4.96%/5.40%，Spread=44.00 APR bp。差异来自固定 1 APR bp 聚合桶及两位小数显示，不是换算或现货百分比。Mid 的两位小数同样可能舍入；数量保留返回的数值/精确十进制字符串。

[精简公开比较快照](public-comparison.json) 保留实际逐字段来源、源时间、采集时间与失败原因；仅公开市场数据。由后一次路由快照提取，统计与盘口可能不同批次，不伪造同一采集时刻。

https://boros.pendle.finance/ 在只读网页 reader 返回 HTTP 451 / Access restricted in your region；web 浏览器文本工具也无法取得动态数值。本次官网实时 UI 数值对照 UNKNOWN，未绕过访问限制；以可访问的官方公开 API 完成生产数据核对。#02 旧截图的 venue/collateral/maturity 布局继续参考，其未知日期、舍入值及 OI 口径差异限制仍有效。新页面明确 API 单边 OI，不倍增以匹配截图。

## 明确限制

- 统计源更新时间、trade-route 全覆盖未公开：UNKNOWN，不借用 book sync。
- USD 价格的源时间不可验证：USD UNKNOWN（PRICE_SOURCE_TIME_UNKNOWN），不假设稳定币等于 1。
- collateral 地址可能未公开、market mode 未有可核验字段：保留 UNKNOWN，不由 market 名称或成交量推断权限。
- best-50 只证明返回层级可见深度；窗口覆盖依据返回尾部与端点标记，不能保证全书或成交规模。
- 只展示市场诊断；未调用 simulate、execute、签名、授权、Gas、监控或通知变更。实时浏览器其他既有头部仍进行原有只读账户查询，未保存账户快照。

## 验证与审查

根类型检查通过；根完整离线测试 108 文件、2584 通过 / 8 跳过；web 类型检查与生产构建通过。默认全并发 web suite 两次在既有 App.setupOnce 的 1 秒初始化等待超时，单独重跑该文件 2 项均通过；最终 2 workers 完整 web：100 文件、1456 项全部通过。现有 React/MSW 输出和 bundle 大小提示保留，不将其当成新功能失败或隐瞒。

审查基点：9b5767817aef9d8c9228fa5debda8091ffcaf753。Standards 轴硬性违反 0，TTL 命名建议已修；Spec 轴聚合桶精度说明缺口已修，复审 0。只关闭 #05 / 第一阶段；父票与第二阶段保持开放。
