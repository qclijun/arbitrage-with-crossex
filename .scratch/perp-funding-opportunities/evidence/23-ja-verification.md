# 23：用户授权 JA 分组后的 Binance / Bybit 补验

后续[规范校准与冷却修正](23-documented-calibration.md)及完整门禁已完成，23当前resolved。下文claimed/尚未提交为本次JA阶段结束时记录，保留历史；最新状态见[完成交接](23-completion-handoff.md)，未观测的能力限制仍保留在21。

2026-10-30，用户明确要求“使用Clash Verge网络代理的JA分组，验证”。本轮仅为验证进程设置 `GATE_PROXY=http://127.0.0.1:7899`；未修改 `.env`、Clash文件、全局选择、JA节点或生产服务。既有 mixed listener `gologin-jms-c18s4` 在7899端口绑定 `proxy: JA`，JA当前选中 `c18s4.portablesubmarines.com:443`。不是将普通7897规则入口假定为JA。

**验证通过：本轮6次公开请求全部HTTP200，两个场所均有正常历史正文。** 初次未指定JA的451/403记录保留为当时结果，不再视为当前JA出口的访问结论；当前成功不证明所有出口、全年分页或限流容量。

## 响应与归档

第一阶段从 `2026-10-29T17:42:44.255Z` 开始，复用23探针，只选择BINANCE/BYBIT：

| 场所 / 请求 | HTTP / 业务码 | 正文条数 | 耗时ms | 配额响应头 |
|---|---|---|---|---|
| Binance BTCUSDT fundingRate，limit=1，365天窗口 | 200 | 1 | 831 | 未返回MBX/Retry-After |
| Binance exchangeInfo | 200 | 产品正文，非历史数组 | 319 | `x-mbx-used-weight-1m=151`；正文同周期 `REQUEST_WEIGHT/MINUTE/1 limit=2400` |
| Bybit BTCUSDT funding/history，limit=1，365天窗口 | 200 / retCode=0 | 1 | 746 | 未返回Bapi remaining/limit/reset或Retry-After |
| Bybit 同窗口，limit=200 | 200 / retCode=0 | 200 | 198 | 同上，缺头继续UNKNOWN |

[manifest](23-ja-samples-20261030/manifest.json)记录每次URL、参数、开始时间、状态、完整响应头（省略set-cookie）、耗时、正文SHA-256与同目录gzip。第一阶段最多4次串行请求、间隔1500ms、超时5s、零重试；达到预定次数即停止。Binance产品分钟权重不是fundingRate/fundingInfo的500/5min共享请求计数器，不据151推算资金费剩余额度。

## 本次请求的 JA 链路证明

另作两次7天窗口limit=1的公开历史请求，用各自TCP源端口匹配Mihomo `/connections`，在本次TLS隧道建立后采集，而不是拿其他进程的旧连接冒充本次请求：

| 场所 | 新连接开始（台北） | 源端口 / 入站端口 | 实际chains | HTTP / 条数 / 耗时ms |
|---|---|---|---|---|
| Binance | 2026-10-30 01:44:02.753 | 39235 / 7899 | c18s4节点 → JA | 200 / 1 / 767 |
| Bybit | 2026-10-30 01:44:05.051 | 40055 / 7899 | c18s4节点 → JA | 200 / 1 / 961 |

[route-proof](23-ja-samples-20261030/route-proof.json)含本轮对应连接ID、host、sourcePort、inboundPort、inboundName、chains与新连接开始时间，并绑定两次正文哈希；节点名称中的账户编号已遮蔽。[route-context](23-ja-samples-20261030/route-context.json)记录既有listener绑定及补验后的JA选择。两次链路探针同样串行、5s超时、零重试、间隔至少1.5s，TLS证书正常校验。

[Mihomo官方listener通用字段](https://wiki.metacubex.one/en/config/inbound/listeners/)说明listener的proxy字段可强制使用指定代理或分组；本轮还通过实际连接chains独立确认JA。最初轮询曾看到其他进程的旧连接，仅作诊断，未用作上述本次链路证明。

## 结论与剩余条件

- JA出口下，Binance和Bybit的公开历史访问缺口已取得成功样本；不再把先前451/403作为当前JA出口的阻塞项。未重构初次请求的完整出口链路，不扩大为整个主机网络的根因结论。
- Bybit的remaining/reset仍未返回，Binance资金费共享计数器仍未知；本轮未出现Retry-After、429/418、业务限流或冷却恢复。其真实限流校准继续UNKNOWN，不为取得样本而耗尽共享IP。
- 23继续claimed，21依赖保留，剩余验收是上述限流/扣账与共享IP负载证据。没有因HTTP200自动启用开仓或改变生产代理。

复跑第一阶段（须全新输出目录）：

```sh
GATE_PROXY=http://127.0.0.1:7899 yarn tsx .scratch/perp-funding-opportunities/evidence/23-public-probe.ts /tmp/issue23-ja-new BINANCE,BYBIT
```

本轮探针新增可选场所筛选，以避免重查其他三个场所；独立strict类型检查通过。6份压缩正文SHA-256/长度复核通过，Bybit三次retCode均为0；原9份非JA归档未覆盖。此次仅改手动探针及证据文档，未改生产实现，未重复上轮已通过的全量verify。日志 `/tmp/issue23-ja-probe.log`、`/tmp/issue23-ja-probe-typecheck.log`。

## 阶段交接

目标是按用户新授权通过Clash Verge既有JA分组验证Binance451/Bybit403。已用7899专用入口完成4次公开请求，并用两次新TCP连接按源端口证明实际chains包含JA；6次均HTTP200，Bybit最多取得200条，Binance产品分钟权重151/2400。没有改Clash、JA选择、.env或生产服务；原提交996098f/9a6e8c1保留，本轮补验尚未提交。验证含探针strict类型检查及6份正文哈希/长度，原归档未覆盖。访问缺口在当前JA出口已消除，真实限流、冷却、扣账与共享IP负载仍UNKNOWN，23保持claimed、21依赖保留，人工开仓关闭。证据为23-ja-verification.md及23-ja-samples-20261030/下manifest、route-proof、route-context与正文gzip；后续只补剩余证据或由用户决定签收，不自动启用。
