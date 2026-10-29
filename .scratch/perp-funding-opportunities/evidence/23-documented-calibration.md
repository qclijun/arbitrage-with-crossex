# 23：官方规则对照、冷却修正与验收边界

规范检索见[五源官方文档及CCXT能力边界](23-documented-rate-limits.md)。当前公开证据为首次9次样本及用户授权JA后的6次样本；后者证明Binance/Bybit可用历史与本次JA连接链路。未主动制造429、封禁或配额耗尽，没有新增业务/账户API请求。此前将“必须实测所有限流类型”作为结单条件过严：23原Scope明确允许未观察行为保留UNKNOWN。

## 本地实现的文档校准

本节描述 `src/core/funding/official-public.ts` 的保护策略，不把本地兜底称为交易所恢复承诺；CCXT未引入生产依赖。

| 场景 | 官方依据 | 修正后的行为 |
|---|---|---|
| Bybit HTTP403且明确access too frequent | [HTTP IP limit](https://bybit-exchange.github.io/docs/v5/rate-limit)：停止会话、至少10min | 识别该文本并作为限流停止本实例后续请求至少10min；更长服务端信号优先。普通地区403不冒充限流。不能关闭其他进程的会话或控制其负载 |
| Binance/Aster HTTP418，缺乏未来恢复信号 | [Binance IP Limits](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info#ip-limits)、[Aster V3 IP Limits](https://github.com/asterdex/api-docs/blob/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md)：禁封2min–3d | 本地保守使用范围上界3d阻断，不声称此次禁封正好3d；已有未来Retry-After等信号时按信号保护，避免无条件3d |
| Binance/Aster的-1003或418正文给出未来banned until | [Binance -1003](https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code)、Aster V3 -1003错误文本含截止提示 | 只识别安全整数且在未来的epoch-ms截止，与头部等待取更长者；过期/无效值不让冷却变成0，不猜其他时间格式 |
| Binance 429/-1003没有未来恢复信号 | [fundingRate/fundingInfo](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)：共享500次/5min/IP | 本地按完整5min兜底；是保守等待策略，不是官方固定解封时刻。已有有效未来信号时保留基于信号的路径 |
| Retry-After秒数/HTTP-date、Bybit remaining/reset | [HTTP标准](https://datatracker.ietf.org/doc/html/rfc9110#section-10.2.3)与Bybit端点头定义 | 既有解析保留；缺头不当0、不当场所必发承诺。Bybit的UID端点reset不缩短IP封禁10min底线 |
| 其他已识别限流、MBX高水位、HL预算 | 五源规范见研究报告 | 既有至少60s保护、MBX匹配同周期容量、HL请求前预留45/响应增权保留；60s是本地策略，未证明所有场所真实恢复或共享IP安全 |

collector收到 `HistoryRateLimitError` 后停止该场所当轮，不按普通错误继续重试。保护只作用于当前reader实例，无法取消已经送达场所的请求、保证其他进程停止或在进程重启后保留内存冷却。后续有新服务端信号时可再校准；本文未声称全主机统一配额或持久化封禁协调已经实现。

## 离线回归与公开证据分离

沿用23原有 `createOfficialPublicReader` / history source公共seam；新增Bybit文本403、Binance/Aster缺头418、未来ban截止（418/429/200业务错误）、Binance无提示429、显式秒数/日期优先及地区403负例。红测分别暴露原来的普通403错误、60s短冷却和未读取ban截止；每个行为修改后对应定向测试转绿。未使用离线fixture冒充真实限流样本。

红/绿日志：`/tmp/issue23-docs-{red-bybit,green-bybit,red-ban,green-ban,red-deadline,green-deadline,red-funding-quota,green-funding-quota}.log`。最终定向3文件37项通过（`/tmp/issue23-docs-focused.log`）。默认完整verify退出0：后端177文件、3625通过/8跳过，前端117文件、1788通过；含根/Web类型检查及全树预算。Web构建退出0（现有bundle体积警告）；未调低测试并发或改门禁。完整日志 `/tmp/issue23-docs-{verify,web-build,typecheck}.log`。

## 完成判定

原Acceptance要求五源结论与来源/样本可追溯、离线/实测分开、实现修改加回归并通过完整门禁、21保留真实限制。它没有要求为了补所有响应头而耗尽IP，也没有要求将实时余量改为已知。上述资料与修复已通过门禁及[双轴复审](23-completion-review.md)，23完成并resolved；真实429/418、未返回头、实际扣账/冷却、共享IP/其他进程负载及跨实例/重启协调继续明确留在21，不能推导完整来源能力或启用开仓。此前claimed历史保留，不伪造补验或抹掉未知。
