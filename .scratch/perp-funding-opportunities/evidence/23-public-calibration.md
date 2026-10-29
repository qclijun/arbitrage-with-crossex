# 23 五源公开历史校准：已取证部分与剩余 UNKNOWN

采样开始 `2026-10-29T17:05:44.903Z`（台北 2026-10-30），共同 cutoff `1793293200000`。共 **9 次**场所公开 HTTP 请求，单进程串行、请求完成后至少间隔 1500ms，单请求 5s、零重试；没有诱发配额耗尽，没有账户请求、交易、出口或服务配置变更。

**本次取证完成，但23未完成验收，保持 claimed。** Binance/Bybit 可用历史、真实限流及冷却证据仍缺；不因其他三个场所 HTTP 成功推导完整来源能力。21继续依赖23，人工开仓仍关闭。

## 可复核公开样本

[完整请求参数、时间、状态、响应头和 SHA-256](23-public-samples-20261030/manifest.json)绑定同目录9个 `*.body.gz`。压缩前正文共约束为每请求最多16MiB，本次压缩归档总计55528字节；正文是HTTP客户端解压后的响应字节，非网络包。保留拒绝正文，响应头仅省略 `set-cookie`，不保存任何认证头。`count=null`表示非历史数组或无可解析样本，不代表零历史。每次请求均有耗时；以下是毫秒范围。

| 场所 | 次数 / 状态 / 耗时 | 已验证 | 未知、访问受限与未观测 |
|---|---|---|---|
| Binance | 1 / 451 / 975 | BTCUSDT历史请求到达HTTP拒绝层；正文说明地区资格限制 | 历史数组、分页、权重、同周期容量、限流冷却全部UNKNOWN；停止该场所，未再取产品 |
| Aster | 3 / 200 / 297–1393 | 产品响应 `x-mbx-used-weight-1m=1`；正文 `REQUEST_WEIGHT/MINUTE/1 limit=2400`；历史limit=1/1000分别取得1/1000条 | 两次历史响应均缺MBX头，因此历史分钟使用量UNKNOWN；无高水位、429/418、真实恢复样本 |
| OKX | 2 / 200 / 324–1052 | BTC-USDT-SWAP近90天，limit=1/400取得1/270条，业务code=0 | 缺Retry-After/配额头；未观测50011/50040或容量边界；不覆盖180/365天 |
| Bybit | 1 / 403 / 866 | 拒绝正文说明CloudFront按国家阻断 | 不是已观测的“access too frequent”限流；remaining/reset、retCode、历史与容量UNKNOWN；停止该场所 |
| Hyperliquid | 2 / 200 / 274–774 | BTC 1天24条、365天请求首500条；响应大小可复核 | 未返回权重余额或限流头；扣账和冷却UNKNOWN；满500条不证明全年完整 |

## 官方规则与本地预算的核对

文档于本次读取；规则不是本次实测容量。以下结论分别受官方来源与上表公开样本约束。

| 场所与官方来源 | 官方规则 | 当前保护 / 校准结论 |
|---|---|---|
| [Binance market data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#get-funding-rate-history) / [general info](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info#limits) | fundingRate与fundingInfo共用500次/5min/IP；分钟MBX权重不是此计数器；429需退避，持续违规可418 | reader 400次/5min，仅本实例。当前地区拒绝，不能证明可用容量；不得将缺头算0或据此放宽预算 |
| [Aster官方V3](https://github.com/asterdex/api-docs/blob/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md#limits) | fundingRate权重1、每页最多1000；429/418、IP共享权重，容量由exchangeInfo声明 | reader 30次/min，collector默认间隔1s；实测1/2400支持同周期比较。历史缺头与文档预期不一致，原因UNKNOWN；仅在已知分钟头≥80%容量时冷却1min，恢复未实测 |
| [OKX funding history](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate-history) | 10次/2s/IP+合约，最多400条、近3个月；全局规则列50011限流 | reader 8次/2s按场所聚合，collector间隔250ms；比文档阈值留余量，但两次成功不能证明高频、窗口边界或共享IP安全 |
| [Bybit rate limits](https://bybit-exchange.github.io/docs/v5/rate-limit) | IP默认600次/5s；API的remaining/current-limit/reset头针对当前端点，UID滚动限额与IP限额有别；10006为业务限流；“access too frequent”403需至少等10min | reader 100次/5s，collector无额外spacing；403地区拒绝不证明配额被耗尽。UID头是否出现在本公开端点仍UNKNOWN，不能把该头当整个IP剩余额度 |
| [HL rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) | IP共享1200权重/min；fundingHistory基础20、每20个响应项额外增权 | 本地保守计算 `20+ceil(n/20)`：24条→22，500条→45，**是按文档估算，不是实测扣账**。reader900权重/min且请求前预留45（至多20个满页请求/min）；collector间隔2.5s；真实并发/扣账/限流UNKNOWN |

本轮读到的实际collector配置为10min周期、偏移1min、4min截止、240总请求/40每场所、每场所并发2、5s超时、非限流错误最多1次250–1000ms抖动重试；限流错误停止该场所本轮。22记录所述12min截止是更早的09建议，不是当前值。见 `src/core/funding/history-collector.ts`、`official-public.ts`。本探针单独更低频运行，未执行完整生产collector；不把其1.5s间隔当成生产spacing实测。

reader额度按实例固定窗口、collector按轮计数，不是跨进程共享IP计数器；容量余量不能证明滑动窗口边界、其他实例、其他程序或其他端点负载安全。5s超时高于这9次样本最慢1393ms，但样本不足以估计长尾；本轮未遇超时或重试，不能据此缩短超时或提高重试。**本票不修改生产配额、spacing、重试或冷却，也不宣称这些设置已通过真实容量校准。**

## 冷却证据分层

| 行为 | 公开实测 | 离线证据 |
|---|---|---|
| Retry-After秒数 / HTTP-date | 9次均无该头，UNKNOWN | `funding-official-public.test.ts`的`retryAfterMs`解析 |
| HTTP429 / 418及业务限流 | 未触发；UNKNOWN | `funding-official-history.test.ts`覆盖HTTP429+Retry-After跨轮冷却；collector测试覆盖模拟限流后停止；public测试覆盖Binance/Bybit/OKX部分业务码。418分支无本轮独立HTTP回归证据 |
| Bybit remaining=0 / reset | 未返回，UNKNOWN | public测试覆盖最后一次成功后阻断至reset |
| MBX分钟高水位 / 一分钟冷却 | 仅产品1/2400；高水位与恢复UNKNOWN | public测试覆盖95/100进入冷却；不能替代真实头 |
| HL响应长度 / 并发预算 | 24/500条已验证，22/45权重为公式估算；真实扣账UNKNOWN | public测试覆盖并发预留45与900上限 |

## 复核与后续条件

手动运行（不在verify，也不自动重试；输出目录必须不存在）：

```sh
yarn tsx .scratch/perp-funding-opportunities/evidence/23-public-probe.ts /tmp/issue23-new-run
```

离线验证归档正文，不发送请求：

```sh
python3 - <<'PY'
import gzip, hashlib, json
from pathlib import Path
p = Path('.scratch/perp-funding-opportunities/evidence/23-public-samples-20261030')
for s in json.loads((p / 'manifest.json').read_text())['samples']:
    raw = gzip.decompress((p / s['bodyFile']).read_bytes())
    assert hashlib.sha256(raw).hexdigest() == s['bodySha256']
print('9 archived response hashes verified')
PY
```

未满足的验收项保留在23及21：①用户提供合规、已授权且可访问Binance/Bybit的公开样本或访问条件，才可补其头与历史行为；不会自行换出口。②真实Retry-After（秒/日期）、429/418、业务限流、Bybit余额耗尽/reset、MBX高水位和HL扣账/恢复，需自然发生且可脱敏追溯的公开请求记录或场所认可的隔离测试条件；不主动耗尽共享IP。③未知的共享IP负载与固定窗口边界还需独立证据。没有这些条件时继续UNKNOWN；本次不请求也不假定用户再次接受UNKNOWN签收。
