# CrossEx 连接复用的作用边界与风险

日期：2026-10-16。研究票：[CrossEx 连接复用能改善哪些等待，且会引入哪些风险](../issues/01-transport-evidence.md)。本研究不批准实施，不调用交易写接口，不重测网络，不打开数据库，不重启生产。

## 可确认的事实

**连接复用值得进入首期设计，但尚不能承诺降低真实下单延迟或未对冲暴露时间的幅度。** 已有独立进程、同一已结束订单的交替查询：当前客户端热查询 819/836/852/956 ms，中位 844 ms；显式池化 143/134/132/128 ms，中位 133 ms。冷调用分别 1331/1131 ms。四个热样本只证明此时此配置的只读查询改善，不是长期尾延迟 SLA。[诊断与原始样本](../../four-leg-maker-requote/book-latency-2026-10-16.md)；原始脚本及 JSON 位于 `/tmp/requote-order-transport-probe.mts`、`/tmp/requote-order-transport-probe.json`，应视为临时证据。

本机安装为 `gate-api 7.2.78`、`axios 1.18.1`、顶层 `https-proxy-agent 7.0.6`。Axios 内部另使用 `https-proxy-agent 5.0.1` 和 `agent-base 6.0.2`，不能把同名不同代际实现混为一谈。版本证据为各自 `node_modules/**/package.json:3`，它们不在 Git 中；这里只保证本次安装快照，不保证其他部署完全一致。

### 为什么当前代理路径没有保留热连接

1. `src/core/clients.ts:55–74` 为每组凭据构建一个带 15s timeout、`proxy: gateProxy()` 的 Axios 实例，交给同一个 SDK ApiClient；未配置自有 agent。
2. 本机 `node_modules/axios/lib/adapters/http.js:86–89,140–176,330–376` 确实缓存 CONNECT agent **对象**，但新建时没有 keepAlive 配置。
3. 更直接的证据：其嵌套 v5 `https-proxy-agent/dist/agent.js:84–121` 在每次 callback 内调用 net/tls.connect，CONNECT 的 `Connection` 为 `close`；嵌套 `agent-base/dist/src/index.js:183–196` 每次 addRequest 调用该 callback，socket free 后直接 destroy。因此这条已安装路径的对象缓存不等于已建立连接复用。这里的结论来自执行源码，不依赖注释推断。
4. 探针改用顶层 v7 `HttpsProxyAgent(url, { keepAlive:true, maxSockets:2, maxFreeSockets:2, scheduling:'lifo', timeout:30000 })`，并设 `proxy:false`，让显式 agent 独立拥有 CONNECT。差异与避免重复建连一致；没有抓 TCP/TLS 事件，仍不能把全部约 711ms 差额精确分配到握手、DNS、代理、服务端各段。

官方 Axios 文档确认 `httpAgent/httpsAgent` 是 Node 自定义 agent 入口；`proxy:false` 会禁止 Axios 包括环境变量在内的代理解析；自有 agent 因而必须自行正确实现已授权的代理路径。Node 19 后 globalAgent 默认 keepAlive 不能反证上面的嵌套 v5 自定义 agent 会池化。[Axios 官方配置](https://github.com/axios/axios/blob/v1.x/docs/pages/advanced/request-config.md)、[Axios 官方 README](https://github.com/axios/axios/blob/v1.x/README.md)。本次通过 Context7 `/axios/axios` 获取；本机安装源码才是版本行为的最终依据。

### 改动影响范围

SDK `dist/api/apiClient.js:39–65,81–105` 每次调用先签名再向持有的 `axiosInstance.request` 发请求，未见 SDK 重试层。`crossExApi.js:184–205,206–233,256–279` 的下单 POST、查询 GET、撤单 DELETE 都使用同一 client.request，没有各自覆盖 agent。因此 transport 的潜在收益可覆盖观察、下单、撤单、下单后确认，并非只改善盘口。

本项目 `makeClients` 同时构建 CrossEx、Spot、Futures；全量替换影响所有这些 API，以及凭据验证候选客户端。`publicCrossEx` 在 `clients.ts:99–103` 另持有 memoized 无签名实例，不会随 signed client 自然一起改变。原生公开盘口已在 `src/core/estimate/books.ts:22–48` 有独立 v7 keepAlive 池（上限 8），不应再重复立项“给盘口加连接池”。没有 `GATE_PROXY` 时以及环境代理/native proxy 环境下的行为必须分别验证，现有收益只覆盖测试时的显式代理配置。

## 对交易风险的意义和边界

- 较快的订单查询可能更早发现 Maker 成交，较快的下单后确认也可能让循环更早继续；但没有真实写接口时序和持续行情年龄证据，实际暴露改善为 **UNKNOWN**。
- 真实下单还有服务处理、CrossEx 转发、交易所排队与匹配，不能承诺同幅 84.2% 改善。历史 A4 的 4.24s 是跨系统时间差，不能全部归因为建连或盘口延迟。
- 保留 Post-only、原撤单确认顺序、每 tick 最多一次交易写操作与单写者。连接池不是并行下单授权，也不能消除送单在途价格变化。
- 最大连接数太小会使仪表盘/批量只读请求占池，排队反而阻塞下单或观察；太大则增连接、限流与资源成本。探针的 `maxSockets:2` 只是实验参数，不是生产选型依据。应计入排队时间并审查读写共享池与独立池两种方案。

## 失败、认证与生命周期的必要约束

**不在 transport 加交易写自动重试。** 旧热连接可能已被对端关闭，出现 ECONNRESET/超时；连接报错不证明订单未被接收。`src/engine/venueGate.ts:129–164` 当前将非确定业务拒绝的 create/cancel 异常归为 UNKNOWN，由原 client ID/订单 ID 探测解决。不可把 ECONNRESET、5xx、超时变为 reject，或在 Axios interceptor 自动重发 POST/DELETE。GET 如将来允许重试，也必须有总时限、限流与防止饥饿约束，不能夹带更改订单结果语义。

下单已成功、随后确认 GET 失败，现有 `venueGate.ts:136–146` 返回已接受 NEW，等待后续观察；不能因为确认请求失败再次创建订单。

每次请求仍由 SDK `model/models.js:2313–2334` 生成 Timestamp、KEY、SIGN。池应只拥有连接配置，不缓存已签名请求或账号数据；保留 JSONBigInt 解析、序列化、15s HTTP timeout、默认十进制 header 与 channel header。不能用新 transport 绕过 SDK 签名/序列化。15s 为当前配置值；Axios timeout 是否涵盖全部池排队/CONNECT/TLS 阶段需故障注入验证，不能直接称为已证明的完整端到端期限。

凭据热切换目前 `src/server/routes/credentials.ts:74–122` 先构建候选、查询账号，再次检查是否开始了活跃 deal，持久化后替换；`src/server/index.ts:278–280` 只替换引用。若新增自有池，需要明确候选失败/忙状态退回、新客户端替换旧客户端、正常关闭的释放责任。不要立即 destroy 仍有在途请求的旧池；不要允许账号切换改变已在途订单后续观察所属账号。默认实现没有新池的 dispose 接口，因此生命周期是新增设计义务，不是“自然已有”。

代理地址变化应销毁空闲旧池并重建，避免继续走旧通道；但须先等待在途请求结束。保留端到端 TLS 校验，禁止为提速关闭证书校验，日志不得输出代理凭据、KEY、SIGN 或请求密钥。重定向/代理故障的认证头行为也应离线覆盖，不能据本次 GET 样本声称所有写路径安全。

## 待决策选项与验收依据

| 选项 | 收益范围 | 主要代价/待核实 |
|---|---|---|
| 暂只补观测 | 不改变传输，可建立真实端到端基线 | 热连接收益暂未落地 |
| signed 客户端统一显式池 | 观察/下单/撤单/Spot/Futures 一致，复用现有 SDK | 仪表盘竞争、热切换和释放需要设计；unsigned client 是否纳入另定 |
| 分开引擎与界面只读池 | 可隔离请求排队，限制紧急操作饥饿 | 更多连接与生命周期，不能制造第二写者；需证明复杂度必要 |

研究不替用户决定生产池上限、读写是否分池、超时调整或 rollout 时间。可供下一决策采用的门槛：离线证明代理/直连、header/签名与序列化不回归；模拟 stale socket/reset、超时、5xx 不重复写且仍 UNKNOWN；候选凭据失败不泄漏池/错账号；只读长时对照观察冷/热、尾延迟、排队和并发影响；最后只在后续已计划实盘交易观测真实创建/确认/撤单/成交到对冲时序，不为测速额外交易。现有 5 次对照不足以设定 P95/P99 数字。

## 证据完整性

依赖源码只读检查、现有探针和官方 Axios 文档是本研究来源。项目文件 clients、books、venueGate、server/index、routes/credentials 均完成 Tier 2 `check_index_coverage`，结果 metadata_match / no_recorded_issue，无报告遗漏；这只是 best-effort 指标。安装依赖不在图索引，以上已按明确位置直接读取。未检查生产进程运行时加载版本，因此本机磁盘安装与运行实例是否完全一致仍待验证。
