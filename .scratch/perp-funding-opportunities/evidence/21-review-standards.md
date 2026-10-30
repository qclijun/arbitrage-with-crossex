# Ticket 21 Standards review

固定基线：`git diff 9728a455b88cb8e69d7b60cc9e234bb4d997a205...HEAD`，受审提交 `2ea469e`。只读审查；未运行服务、交易、部署或修改仓库。范围为新增集成/账本测试、fixture修改、手动浏览器bridge/CDP/驱动、验收材料与工单地图整理；生产源码没有变更。本文件是审查产物，不是生产证据。

## Documented standards violation

### S1 — P3: Synthetic position value crosses JavaScript floating point (已修复并闭环)

- 文件：`.scratch/perp-funding-opportunities/evidence/21-browser-server.ts:42`。
- 代码：`position_value: String(Number(p.positionQty) * 2500)`。
- 规则：`AGENTS.md:19` 要求金额、数量保持decimal字符串；`docs/agents/architecture.md:88` 明确decimal strings end to end、never floats。
- 风险：即便最终重新转成字符串，`Number`乘法已经丢失十进制精确性。这里只有合成账户，当前0.05×2500恰好是125，因此没有观察到当前14步验收错误，也没有生产资金风险。此项是已写明标准的局部偏离，不能表述为生产计算缺陷。
- 修复：现有`fxStr` import同时引入`fx`，改为`fxStr(fx(p.positionQty) * 2500n)`。沿用已有固定点工具，不需新增领域抽象或架构。
- 当前状态：修复已提交be46437。定点复审2ea469e...be46437确认只改harness浮点表达式为fx/fxStr固定点；strict typecheck及完整14步/6项401认证复验均退出0。审查者核对validation manifest中的日志SHA-256和3份harness源码SHA-256全部匹配，S1闭环。不必为单行合成值转换新增镜像单测。

## Checked boundaries; no additional violation found

- HTTP隔离：`tests/helpers/funding-board-fixture.ts:99-105`仅`app.inject()`；两份新server test使用该fixture及fake venue，未调用listen。手动bridge不是Fastify listener：`21-browser-server.ts:108-109`仍inject，`:146-149`独立随机端口绑定127.0.0.1。`:14-15`阻断Node外连；CDP `21-browser-cdp.mjs:43-54`仅放行当前origin/data。对应`development.md:57-62`和`architecture.md:77-82`。
- Token/Host/Origin：bridge `21-browser-server.ts:50-51`先验证请求Host及存在时的Origin，`:85-89`先统一校验/api token再提供bootstrap/转发，`:107-109`只在bridge白名单通过后规范到inject用Host/Origin。实际6688只是注入header字符串，没有连接该端口。`21-browser-check.mjs:57-64`对credentials/account/funding机会页的缺失和错误token共6项断言401。
- Loop独占：`funding-integrated-readiness.test.ts:117-142`沿正常tick验证关闭准入后的原授权转换及每tick至多一次create/cancel；其它测试只安排FakeVenue truth和合成读端口。`funding-ledger-lifecycle.test.ts:43-46`的SQL明确限定旧账本fixture布置，非产品恢复代码或真实账户操作。
- Decimal：交易数量、费用与断言使用decimal字符串；发现的唯一显式数量浮点算术见S1。`funding-integrated-fixture.ts:21-23`中的quote number字段遵循已有VenueFundingRate shape，不把该已存在输入表示另列为本票生产变更。
- 凭据/证据：diff不含.env、api-token、data或SQLite文件，bridge bootstrap明确SYNTHETIC、test token复用现有常量。固定diff仅提交一个最终14步截图目录；失败信息单独保留JSON/说明，未把失败截图当最终PASS。`.gitignore:50-52`令后续运行目录和pointer留本地。`21-browser-acceptance.md:3-9`及`:31-39`明确synthetic/UNKNOWN/不交易边界。
- 文档历史：map移出的实施原文落入`map-implementation-log.md:3-16`并由map链接，符合`issue-tracker.md:17`保留历史。21当前claimed及认领评论与当前审查/待签收阶段一致；最终完成后按`:27`追加Answer并resolved属于主任务收尾，不在本审查误报为已完成后漏关票。
- 文件预算：未把工具已强制内容重新列成审查发现。`development.md:41-44`允许生成数据/证据dump豁免；现有`.token-budget.json`已有`.scratch/**/evidence/**`豁免，本票没有提高阈值。地图按责任拆历史，未发现通过压长行规避预算。

## Judgement calls / Fowler smells

没有需要单独提出的判断性smell。`w`/`s`是短生命周期测试world/status；少量重复用户动作对一次性验收脚本仍可直接阅读。没有为了disposable harness要求通用框架、多态或新的领域抽象。

## Validation and limits

未重跑全量门禁或浏览器，避免只读review重复更改运行证据；静态核对最终evidence JSON的result=passed、14 steps、6 authChecks，以及validation manifest记录的生产源码diff为空。未独立人工复核全部PNG或阅读全文日志；完整gate与截图QA的现场执行结论由主任务已有证据负责。未审本基线之前的生产实现或既有fixture设计。

## 阶段交接

目标是按仓库标准复审21新增测试、隔离浏览器harness及证据地图，固定提交2ea469e，未改仓库。静态确认API认证、Host/Origin、localhost独立端口、app.inject和fake IO边界，没有生产源码或真实账户数据变更。发现一处低风险明确标准偏离：browser-server第42行通过Number计算合成position_value；用现有fx/fxStr固定点工具即可修正。当前0.05场景未见错误。详细定位、规则、风险、修复和检查限制均在本文件。主任务已提交两行定点补丁be46437，审查者确认diff及复验日志/源码hash，14步/6项认证和strict typecheck已通过；S1闭环。旧run已取消跟踪、本机保留，待主agent提交该证据收尾。全量门禁无需因审查本身重复运行。

## 定点复审收尾（be46437 + 暂存证据整理）

- 复审diff：`git diff 2ea469e...be46437`，生产src/web/src及tests均无差异；harness仅fx import和position_value表达式两行修复。
- 新最终run：`21-browser-runs/2026-10-30T00-14-55-853Z/`。原始JSON为passed、14步、6项认证全401、1个deal、2次create、admission.open=false。核验browser-typecheck.log及browser-check.log实际文件SHA-256与21-validation.json一致；3份harness源码SHA-256亦一致。
- 证据整理复核：be46437最初仍跟踪旧run的16文件，但文档称旧捕获仅在历史提交；向主agent指出后已对旧run执行git rm --cached。已读取暂存D清单、git ls-files按run计数确认index仅新最终run的16文件；旧run本机evidence.json仍在，历史2ea469e可恢复。此项已在待提交index闭环，不是删除本机备份。
- S1已关闭，无剩余Standards阻断项。父agent已实际view_image新Positions/partial；本审查未冒充独立图片QA，亦未亲自重跑命令。最终历史证据清理暂存尚待主agent提交。
