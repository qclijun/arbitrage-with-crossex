# 工单20实施交接

目标：06-Q4持久兼容基础。用户确认接缝（2026-10-28）：`PRAGMA user_version`为账本版本；迁移步骤注册表、全部待执行步骤与版本号同一事务；VACUUM INTO一致备份＋校验清单；v1为旧程序屏障（`alerts`改名`alert_log`，同名索引占住`alerts`）；v0→v1要求全部deal DONE且无PENDING/OPEN/隔离订单（HALTED亦拒绝）；安装器按标记拒绝回滚；`yarn ledger:restore`仅在迁移后无任何写入时恢复并保留被替换账本。

## 交付

- `src/engine/ledger/version.ts`：`prepareLedger`在Store构造内、任何读写前运行。版本高于本程序→`LedgerRefusal('future-version')`，不写文件、不改标记；需收敛的步骤遇未完成deal/活动/隔离订单→`not-quiescent`，列出deal与client id，零写入、无备份、无标记，旧程序仍可启动。否则：非新库先备份→写`data/ledger-version.json`为目标版本（提交前写，崩溃只会多拒绝回滚）→关FK→单个`BEGIN IMMEDIATE`执行v0建表补齐、各步骤、`ledger_migration`日志（含备份文件/sha256及迁移后内容指纹）、FK检查、`user_version`→提交；任一失败整体回滚并把标记写回原版本。`LEDGER_STEPS`是领域票（19开关、12意图、15切片、16 Risk）唯一的迁移入口；改变既有行语义的步骤须同时屏蔽会误读的程序。
- `src/engine/ledger/legacy.ts`：v0建表及原`migrate()`的列补齐/CHECK重建，移出`db.ts`并改为在调用方事务内执行（原实现ADD COLUMN非整批原子，现整体原子）。
- `src/engine/ledger/backup.ts`：从持有EXCLUSIVE锁的连接`VACUUM INTO`临时文件（含已提交WAL），只读重开校验integrity、版本、逐表行数后fsync并改名；清单`<备份>.json`含版本、时间、字节、sha256、行数。目录0700、文件0600（Windows继承数据目录ACL）。
- `src/engine/ledger/restore.ts`＋`scripts/ledger-restore.ts`（`yarn ledger:restore <备份>`）：校验清单sha256；在账本自身锁下确认是最新迁移的备份、内容指纹与迁移时一致；否则`backup-unverified`/`ledger-in-use`/`not-latest-backup`/`ledger-has-new-writes`拒绝且不改动。允许时原账本（含-wal/-shm）改名`deals.sqlite.replaced-<UTC>`保留，备份经临时文件fsync后放回，标记写回旧版本。
- `install.sh`/`install.ps1`：`restore_app`/`Restore-App`在停服务或移动任何目录前检查`data/ledger-version.json`对比`app.old/ledger-support.json`（缺失视为0；标记不可读视为已升级）；超出则明确说明并不回滚。`ledger-support.json`声明`maxLedgerVersion`，测试锁定等于`LEDGER_VERSION`。
- `src/server/index.ts`：`LedgerRefusal`打印原因并退出1；`db.ts`告警SQL改用`alert_log`。

## 兼容矩阵与入口

| 程序 \ 账本 | v0 | v1 |
|---|---|---|
| 6f0f051首个engine至1.7.7及本票前HEAD | 正常 | 启动即`there is already an index named alerts`退出，早于loop/listen，账本字节不变 |
| 本版本 | 收敛则备份并迁移；未收敛拒绝且零写入 | 正常；更高版本拒绝 |

实测：`git archive`取6f0f051、136f2f7（1.7.3）、93bdd31（1.7.7）、21b51bd的`src`，各自真实`Store`分别打开本版本迁移出的v1合成账本（全部拒绝、sha256不变）及其v0备份（全部可启动），日志`/tmp/ticket20-evidence/release-matrix.log`。CLI拒绝/恢复实跑见同目录`cli/`。

入口：macOS `install.sh`回滚在bash下实跑（`tests/server/installer-ledger-rollback.test.ts`）；Windows `install.ps1`本机无PowerShell，仅静态断言，**未实机验证**；应用内更新调用同一安装器，原本已拒绝活动deal。源码`yarn dev/start`及任何旧程序依赖存储屏障。手工复制备份覆盖账本、手工SQL改`user_version`或删除索引不受支持，不承诺安全。

## 未覆盖与交接限制

- 19尚未实现关闭/排空协议：本票的“先关新增风险”仅由“迁移在listen前执行、v1要求全部DONE”体现；真实升级端到端仍由19/21验证，不能据此宣称真实升级已可执行。
- Gate CrossEx无dead-man保护：迁移被拒绝或新版本启动失败且不能回滚时，无服务器监控仓位；v1仅在全部DONE时迁移，但迁移后新开的deal若新版本再故障只能前向修复。
- 未对真实库执行迁移、停机或回退；全部为临时合成SQLite。

## 验证

新测试：`tests/unit/ledger-version.test.ts`（13）、`tests/unit/ledger-restore.test.ts`（5）、`tests/server/installer-ledger-rollback.test.ts`（8）；`engine-store-migration.test.ts`种子改为已结束deal（未收敛拒绝由新测试覆盖），安装器回滚测试加载新函数。tsc通过；root unit/server 146文件3361通过/8跳过，文件预算通过；`yarn --cwd web build`退出0。默认`yarn verify`退出1：web 1/1711失败（`App.setupOnce`找不到Settings对话框），日志`/tmp/ticket20-verify-run1-fail.log`。随后默认并发重跑web两次：一次`FinishSetupPill`失败、一次1711全过（`/tmp/ticket20-web-run3.log`）。本票未改web；失败测试每次不同，主机负载约25（16核，6个长期SAT求解进程满载）。未改测试或配置，最终完整门槛于全部实现后重跑。
