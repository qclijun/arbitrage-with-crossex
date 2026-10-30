# 21正式页面浏览器验收

结论：隔离技术验收通过。最终运行[原始记录](21-browser-runs/2026-10-30T00-11-19-791Z/evidence.json)共14步、1个deal、2次由用户分别确认的接受请求（第一次409变更拒绝，第二次202接受后截断响应），不是2个执行。前端fetch记录、服务端请求与intent/deal身份可对照；刷新后只有查询，没有补发接受。

环境：Linux、Chrome156.0.8078.73全新profile，Node24.21.0，正式`web/dist`。通过Node localhost桥向真实`buildApp`调用`app.inject()`，没有让Fastify测试app监听。bridge只允许本次origin，Host/Origin规范到测试app的localhost:6688；这只是注入参数，从未连接6688。API token为既有TEST_TOKEN；所有/api含合成bootstrap均统一认证，前置6项缺失/错误token检查返回401；账户、合约、历史、盘口、费用、Boros卡片及交易均为合成夹具。页面外站请求全部拦截，Google静态图标回退为文字；Node nock与fetch封锁外连，未使用真实账户或RPC。

服务端、缓存元数据、引擎与浏览器共享同一虚拟日期并随真实耗时推进；没有延长10s期限、800ms长按或300s maker默认期限。只有fake engine的tick与stale故障注入推进虚拟时钟。原始历史publishedAt没有刷新冒充新证据。Boros钱包未注入，旧向导如实要求安装钱包，不伪造签名或执行。

## 实际交互及截图

下列文件位于`21-browser-runs/2026-10-30T00-11-19-791Z/`，已人工查看关键截图；每步DOM文字、页面时钟及fetch记录见同目录evidence.json。

| 步 | 已验证行为 | 截图文件 |
|---|---|---|
| 1 | 首次准入关闭；正/负方向同列，历史合格不等于可开仓 | `21-browser-observation.png` |
| 2 | 正利差过滤变为1/2，保留全局全集分母与详情 | `21-browser-filtered.png` |
| 3 | 精确数量/杠杆/maker价格/期限/持有天数；正常与转换费用、IOC无硬上限警告 | `21-browser-preview.png` |
| 4 | 编辑使确认失效；短按不发送；费用变动409返回新预览，两个确认框重置且0个deal | `21-browser-reconfirm.png` |
| 5 | 重新确认后接受、截断响应；按持久intent查询恢复，只有一个deal，接受不冒充成交 | `21-browser-recovered.png` |
| 6 | fake maker部分成交0.05并对冲；关闭准入后刷新/重新进入A页仍是原deal与原deadline，无补发 | `21-browser-restored-partial.png` |
| 7 | 实际打开deal view并点击独立Stop；不是全量Stop或页面补单 | `21-browser-stopped.png` |
| 8 | DONE仍如实显示两腿各0.05、未买0.1；仅2个fake create，不补齐残余 | `21-browser-terminal.png` |
| 9 | Positions→Strategy ownership：两腿各0.05、reconciled、未归属0；切片收益/费用UNKNOWN，缺当前认领证据时拒绝认领 | `21-browser-positions.png` |
| 10 | Risk保留缺证据UNKNOWN/WARNING，没有因两腿名义对冲或页面切换清绿 | `21-browser-risk.png` |
| 11 | 原Opportunities的三腿/四腿卡片、费用/资本详情和入口均保留 | `21-browser-legacy-entries.png` |
| 12 | 三腿入口实际打开原向导，钱包不足明确显示，不交易 | `21-browser-legacy-wizard.png` |
| 13 | 四腿入口实际打开对应Binance long向导，不与三腿身份混淆 | `21-browser-legacy-four-leg-wizard.png` |
| 14 | 跨整点且刷新失败，保留原发布时间并停止排名；准入仍关闭 | `21-browser-stale.png` |

跨数量的4.03/0.36/3.67、HYPE缺证据、consumer版本和历史告警由矩阵所列真实TS/Python/组件回归证明，不把此ETH0.05浏览器夹具冒充所有账户/策略/钱包的验收。Positions资产农场钱包空态、认领证据不足及Risk外部证据UNKNOWN是有意保留的限制；没有验证钱包签名或Boros实盘写入。

## 重跑与故障记录

```sh
yarn --cwd web build
node .scratch/perp-funding-opportunities/evidence/21-browser-check.mjs
```

驱动自动启动/结束独立fixture进程组和Chrome，仅允许localhost；每次输出独立时间目录，失败也留JSON/截图。无新增依赖，不接运行终端。Node/Chrome同本机复现；未声明跨OS浏览器支持。早期驱动/夹具问题与最终PASS分开记录于[失败历史](21-failure-history.md)，不把初测错误称为产品修复。
