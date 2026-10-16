# 引擎专用签名连接池

工单 08 提供可选择、有界且可退役的引擎传输。默认关闭，当前生产入口不会读取
环境变量来开启它；07 真实基线、06 RSS 准入以及最终组合验收尚未通过。
后续 10 号票须完成对照、记录最终连接数并接入受控启用，不能以本票离线通过启用。
本票没有部署、重启、访问真实账户或执行交易。

## 范围与选择

`EngineTransport` 只由服务器的引擎 `gateVenue` 使用；每次 Venue 操作借用一个
固定客户端，覆盖订单查询、创建及随后的确认、取消，以及原标识探测/历史扫描。
UI、其他签名消费者、Spot/Futures、候选凭据验证、unsigned CrossEx 与公开盘口
继续沿用原客户端/已有盘口池。SDK 的签名、时间戳、JSON/大整数/十进制处理及默认
`X-Gate-Size-Decimal`、`X-Gate-Channel-Id` 头仍由同一初始化函数设置。

内部选择接口是 `owner.configure({maxSockets: N})`；`configure(null)` 独立关闭池化。
必须显式给出整数上限 1..16；没有隐含默认值，不自动扩池。这个范围只是实现硬边界，
不是已验收的生产参数。该接口供已批准的离线测试和后续受控接线使用，不新增 HTTP
交易写者或未验收的环境开关。

每个池同时限制 maxSockets、maxTotalSockets、maxFreeSockets，采用 keepAlive/lifo，
空闲 socket timeout 为 30s。保留每请求 15s Axios timeout；它未被证明涵盖全部
Agent 排队、CONNECT 和 TLS 阶段，不能当作完整端到端期限。

## 路由、失败与账号归属

显式 GATE_PROXY 沿用 `gateProxy()` 的解析结果，包括其既有不使用 URL 认证信息的
行为；没有 GATE_PROXY 时，使用 Axios 同版本依赖 `proxy-from-env` 的 HTTPS_PROXY /
ALL_PROXY / NO_PROXY 选择。该依赖现在显式列入 root package，沿用 lockfile 中已有
2.1.0，不改变 Axios 版本。IPv6 地址不重复添加括号。

选中池后由自有 Agent 唯一承担 TLS/CONNECT，Axios 设置 proxy:false，避免第二层
代理解析；代理失败不会直连回退或换池重发。证书校验保持开启。引擎专用签名请求
禁止跟随 HTTP 重定向，防止 KEY/SIGN 发往其他 origin；3xx 按原未知/读取失败路径
处理。普通客户端的重定向行为不变。

未增加任何读/写自动重试。超时、ECONNRESET、5xx 或非确定业务标签的写请求继续
UNKNOWN；由写前登记的原 client/order id 探测。创建成功但确认失败继续返回接受的
NEW 快照，不重新创建。客户端构建或路由配置失败也不能触发 fallback 或写重试。

候选凭据仍由普通客户端验证；失败和 await 后忙状态重查拒绝都没有分配新引擎池。
验证成功且无活跃 deal 后，现有持久化/替换顺序保持；setClients 同步使旧池退役，
新池直到下次引擎操作才创建。账号切换的既有 busy 检查未放松。

账号/代理/参数变化或关闭选择时，旧 session 不接受新 Venue 操作。已借出的完整
操作链可以完成，包括同一个旧账号的下单确认与分页；待链结束才销毁其连接。
“退役不接新操作”不代表中断已有操作链的后续确认。代理变动在下一次借用时识别，
新操作走新池，在途链保持旧路由。关闭池化后的新操作使用原客户端，在途旧链继续
完成。正常 app.close 等待新增资源 drain；不打断请求、不强停在途交易链。

池仅保存连接配置及 SDK 客户端归属，不缓存账号查询结果、订单响应或已签名请求。
不输出代理地址、认证材料或完整请求/响应。`stats()` 汇总当前与正在退役的
session 的连接/队列/在途计数，并显式列出退役数与各池上限之和；切换期间不能只看
当前池而遗漏旧连接。每个 generation 独立有界，在途退役可暂时与新池重叠，
最终资源验收必须包含这种切换高水位。

## 离线证据与候选参数

```sh
yarn typecheck
yarn vitest run --project server tests/server/engine-signed-pool.test.ts tests/server/engine-pool-lifecycle.test.ts
yarn vitest run --project server tests/server/engine-pool-connection.test.ts
```

本机连接测试需允许回环 listen 和测试子进程；全部目标为 127.0.0.1 的合成 TLS
origin / CONNECT proxy，使用固定假凭据和测试 CA。CA 只通过子进程 NODE_EXTRA_CA_CERTS
加载，未设置 NODE_TLS_REJECT_UNAUTHORIZED=0。私钥为公开测试 fixture，绝不能用于部署。

要重新保存候选证据，可在最后一个命令前设置
`ENGINE_POOL_TEST_EVIDENCE=/tmp/engine-pool-local.json`。文件仅包含合成请求的耗时、
socket/队列/FD/RSS 采样；不含真实账户资料。已保存的结果见
[本机候选证据](validation/engine-signed-pool-local-2026-10-16.json)。

并发压力为每轮 8 个只读请求，共 2 轮，每响应故意等待 30ms。测试 1/4/8 上限，
精确验证两轮各只建立 N 个 CONNECT 隧道、连接不超上限、超量排队、热连接复用，
同时覆盖直连、环境代理/NO_PROXY、证书不可信、代理拒绝和真实写 socket reset。
另验证在途操作跨代理切换仍完成原链；reset 写只到达本地 origin 一次。
实际 SDK HMAC、默认头与十进制正文从可控传输边界校验。

候选起点为 **1**：当前单写者 Venue 操作串行，查询/确认逐次等待，不应为合成
8 路并发擅自放大生产连接。4/8 是并发压力下的候选对照；没有照搬旧探针的 2。
最终连接数仍 UNKNOWN，必须用真实本机只读对照的排队、尾延迟和资源证据定值。

这些每配置仅 16 个合成只读样本，没有三组交替和逐组 100 个成功样本；RSS 为短时
采样高水位，FD 包含 Node/测试运行时，不是稳态增量或连接 FD 的独立归因。
不能据此宣称生产 p95 改善、资源门禁通过、经济暴露下降或可以启用。

引擎入口测试使用临时文件 SQLite 和现有 VirtualClock；行情可控，签名调用走真实
SDK 与 nock 外部边界，验证写前 PENDING、每 tick 最多一次写、数量不重复追补，
以及 UNKNOWN 保持 PENDING 后按原 client id 观察。不是仅靠 FakeVenue 声称传输通过。

配置与普通客户端共用导出的 15s timeout 常量，防止后续维护时悄然分叉。
