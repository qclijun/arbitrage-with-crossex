# 工单06：兼容、停用与验证事实

2026-10-27，基准04d572a；只读源码/配置核查，不是运行验证或用户政策。完整工作记录：/tmp/perp06-compat-stop-facts.md、/tmp/perp06-validation-facts.md。

## 持久化及程序回退

- src/engine/db.ts:289—343：SQLite WAL/FULL/FK及EXCLUSIVE单实例；启动通过列/DDL探测做幂等升级。检查的DB/启动路径没有通用schema版本兼容拒绝门槛；读取mode等主要静态强转（149、154—159），不能推断未来枚举安全。
- db.ts:377—419：pair重建保留实际列/行、索引和trigger，事务FK检查后提交，失败回滚。这仅是局部重建事务；前面的ADD COLUMN并非整批原子。不能宣称启动失败会自动恢复整个旧库。
- src/server/index.ts:112—127：除锁冲突特殊提示外迁移失败向外抛出，无只读降级分支；315—340在listen成功后才启动loop。loop.ts:831—881正常reconcile继续旧活动deal，不重置为新单。
- install.sh:236—279、382—385：app/app.old切换回退程序，data目录外置且不被DB快照恢复。旧程序可能面对迁移后的同一库，不能把程序回退当成已验证数据库降级；Windows完整流程未审。
- tests/unit/engine-store-migration.test.ts:129—330有临时SQLite旧schema/行/索引/trigger/FK/重开幂等回归；本轮未运行，且不能证明未来切片迁移。

## 关闭入口与活动执行

- src/server/routes/deals.ts:321—336及engine/loop.ts:788—816：现有stop/resume是逐deal命令。STOPPING/HALTED取消可取消maker，PENDING/quarantine先取证，合法可对冲量才补B；不保证立即补齐或无残余（decide.ts:236—328、loop.ts:286—345、610—623）。
- reduceOnly同样走这些控制；对全部活动票发stop也会停止A侧继续减仓。因此它不是现成的“只禁新风险且保留减风险进度”。
- scripts/stop.sh:16—45停止整个服务；loop停机也停止probe/hedge，不能作为保持在途收敛的功能开关。检查的engine、app及deals路由未定位到本功能持久化的新风险准入开关；不作全仓穷尽断言。
- version.ts:54—92更新入口拒绝活动deal等，但updater.ts:43—49/89—101只是进程内更新窗口；deals路由未检查isUpdating。不能把更新按钮当持久全局互斥或停用承诺。
- scripts/latency_report.py:351—368、392—409、428、744—756已有回退证据审计，读取inFlightDrained/ledgerPreserved/noResend等attestation；它不执行启停、排空或DB回滚。

## 验证入口和限制

| 入口 | 实际覆盖及边界 |
|---|---|
| yarn verify | root/web类型、文本预算、root unit/server及web Vitest；不含bundle/Python/真实浏览器 |
| yarn --cwd web build | 类型及production bundle；不证明交互、真实场所能力或订单事实 |
| python3 -m unittest discover -s tests/monitor -v | Risk及共享report相关独立套件，变更consumer时须验证 |
| python3 -m unittest discover -s tests/screening -v | screening独立套件，历史/机会筛选相关变更须验证 |

证据：package.json:13—28、web/package.json:9—15、.github/workflows/verify.yml:21—38、docs/agents/development.md:5—19。pre-commit只查暂存预算。CI当前verify/build不包含Python或真实浏览器；jsdom/css:false也不证明最终布局交互。

server须app.inject、fake venue并封锁真实HTTP。nock现有setup允许本机连接，不是OS网络隔离（tests/server/helpers/setup.ts:10—18）；不得借此listen或连接运行终端。live测试可真实交易，显式opt-in不属于本轮或常规验收。正常dev代理会连接API并附token，不能当隔离测试入口。

## 覆盖与结论限制

两个事实任务均用codebase-memory Tier2定位并回源，generation/indexed_at=2026-10-27T01:57:12Z；兼容任务16条路径、验证任务35条主路径及额外verify_roll_fok路径coverage均metadata_match/no_recorded_issue。scripts/tests部分泛搜仅定位，图为best-effort；其他测试两行parse_partial已回源，不影响已查迁移测试结论。

没有检查实际DB/账户、运行跨版本二进制、演练备份回退或执行测试。以上事实只能输入06决策，不能预先标成新版本兼容、停用或验证已通过。

## 候选定稿核查

主代理在Q1—Q6用户全部确认后补18—21及implementation-plan.md，更新原票依赖。39份Markdown、175个本地链接及21票依赖图检查通过、无环；06仍claimed，08—21均受06阻塞。当前可研究07，模拟06最终确认后可启动07/20；18只读阶段不传递依赖11—17。证据/tmp/perp06-doc-validation.log，文本预算及diff whitespace检查通过。

双轴审查未解决发现均0，最高严重度均无；完整报告/tmp/perp06-spec-review.md及perp06-standards-review.md。最终阶段交接/验证事实增量亦已复核，无待复核项；不将代理审查当用户最终共同理解确认。

本轮只改规划文档，没有产品/测试/脚本变更。按implement流程运行默认yarn verify：root类型/预算及137文件3278项通过、8跳过，web类型通过；web共109文件，107通过/2失败，1708项通过/2失败。失败为App.setupOnce查找Settings dialog及PairTicket重挂载5000ms超时，和原型阶段同名；本轮未定位根因，也未改动或放宽测试。

两文件单独诊断26项通过（约33秒），不能替代默认完整门槛。web production build通过（约39秒，既有大chunk警告）；本轮不涉及Python源码，未运行Python或浏览器/迁移/真实服务验证。日志及退出状态：/tmp/perp06-verify.log/.exit、perp06-focused-diagnostics.log/.exit、perp06-web-build.log/.exit。默认verify仍非零，不称本轮完整gate全绿；正式实现21必须查因并达到已确认Q6门槛，原型及本轮旧代码测试不预填未来矩阵通过。
