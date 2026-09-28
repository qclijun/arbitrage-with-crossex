# 项目规则 — arbitrage-with-crossex（本地运行，非开发上游）

## 这是什么仓库

Pendle 官方开源的交易终端：Boros 固定资金费率 × Gate CrossEx 永续对冲的 delta 中性套利。
**本地检出用途是「审计后锁定 commit 运行」，不是开发上游**。

- 锁定 commit：`02971e98d02c89b866bcabdced13a6766972b32c`（Release 1.7.2）
- 升级前必须重新审计：`git fetch && git log --oneline HEAD..origin/main`，逐个 review 变更后再决定是否跟随
- ⚠️ 该软件用真实账户下真实订单。任何改动/操作前先想：这会不会影响正在运行的交易？
- 有持仓期间**不能停服/休眠**（CrossEx 无 dead-man's switch）

## 命令速查

```bash
yarn install --frozen-lockfile          # 根目录 server 依赖
yarn install --frozen-lockfile --cwd web   # web 是独立 package（无 workspaces），必须单独装
yarn start                              # 构建 SPA + 启动 Fastify（http://localhost:6688）
yarn dev                                # tsx watch + Vite dev server（/api 代理到 :8711）
yarn typecheck                          # tsc --noEmit
yarn test                               # unit + server 套件（离线，nock 拦截真实 HTTP）
yarn test:web                           # 前端组件测试（jsdom + msw）
yarn verify                             # typecheck + 全部测试
```

- ⛔ `yarn test:live` / `test:live:smoke` / `live:cleanup`：会在真实账户下 ~$20 真实订单。除非用户明确要求并确认 `LIVE_TRADE_ACK`，绝不运行。
- 常用 API（脚本调试时需带 token）：
  `curl -H "x-arb-token: $(cat api-token)" http://localhost:6688/api/positions`

## 架构（改代码前先读 docs/MAKER-HEDGE.md）

- `src/core/` — 无框架领域库：clients（Gate SDK 签名）、orders/numbers（tick/lot/价格格式化）、
  estimate（VWAP 撮合预估）、boros/（机会定价 + 双腿执行）、preview.ts
- `src/engine/` — **执行引擎**：单写者 reconcile 循环 + SQLite(WAL) 系统事实源；
  recovery 就是循环本身，不要绕过 loop.ts 直接改 venue 状态
- `src/server/` — Fastify：loopback 绑定 + Host/Origin 校验 + `x-arb-token` 认证 +
  TTL 缓存（429 时回源 stale）；`/api/deals` 路由只写意图，venue 变更归 loop
- `web/` — React 18 + Vite + Tailwind + react-query，独立 package
- 符号格式：`{EXCHANGE}_{BUSINESS}_{BASE}_{QUOTE}`，如 `BINANCE_FUTURE_BTC_USDT`
- 测试分 vitest project：unit / server / live（live 需 `LIVE_TRADE_TESTS=1` 才加载）

## 本机环境（Linux，非官方支持平台）

- Node v24.21.0（nvm，`~/.zshrc` 硬编码 PATH）；yarn 1.22.22（corepack shim）
  — `nvm install` 新版本后需重新 `corepack enable`
- Linux 无官方安装器/LaunchAgent：后台常驻需自写 systemd user unit；应用内 Update 按钮不可用（updater.ts 把非 win32 按 macOS 处理），更新 = 手动 git 跟进
- 数据目录：源码检出状态下凭据写 `<repo>/.env`，交易日志写 `<repo>/data/`，API token 写 `<repo>/api-token`（均已被 .gitignore 忽略，绝不提交）
- 本机代理敏感点：Clash Verge TUN 曾劫持长连接；Gate/Boros API 连接异常优先排查代理路由

## 仓库纪律

- 上游文件（README.md、CLAUDE.md、src/、install*）尽量不动；本地改动（如 .trae/）提交在本地 dev 分支，main 保持与 origin/main 字节一致；deploy/ 已被 .gitignore
- 绝不提交：`.env*`、`api-token`、`data/`、`*.sqlite*`、`disclaimer.json`、`tests/fixtures/gate/recorded/`（含真实账户数据）
- 上游分支模型：main=发布分支（squash merge），dev=集成分支；本地检出保持与 origin/main 同步即可
