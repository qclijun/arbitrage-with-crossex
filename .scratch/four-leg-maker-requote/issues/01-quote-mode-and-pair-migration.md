Type: task
Status: resolved

# 01：四腿报价模式与 pair 表迁移前置

**What to build：** 让「报价模式」成为一条可以安全扩值的持久化事实，并且让已有安装的账本能继续打开。为报价模式新增取值 `最优价`（挂同侧最优价本身），并把它写进 `pair.price_policy` 的取值约束；同时让迁移逻辑能作用于 `pair` 表，使这个新取值在**既有数据库文件**上也能落盘、读取与生效。工作完成后旧库开箱行为不变，新取值可用，且依赖计数的规则不会因为读不到列而静默失效。

本工单不改变任何用户可见的报价行为——它只是让后续工单可以在旧库上正确工作。

**Blocked by：** 无（可立即开始）

**Status：** resolved

## 背景

现有迁移逻辑只探测订单表，对 deal 表没有任何加列分支，而建表语句的「若不存在」形式对已存在的表什么都不做。因此一个新列只写进建表语句时，**只会作用于新建数据库**，已有安装永远拿不到它。更隐蔽的是：读取用 `SELECT *`，缺失的列会成为「未定义」而不是报错，并直接进入领域对象。

**验收标准**

- [ ] 报价模式新增「最优价」取值，语义为「初始挂同侧最优价，且每次重挂都按当时的同侧最优价重算」；该取值写入 deal 表的取值约束。
- [ ] 迁移逻辑新增针对 deal 表的列探测分支，可为缺少新列的旧库补列并带默认值；沿用现有「只做加法、不改写既有行」的写法。
- [ ] 新列同时出现在建表语句、迁移分支、写入语句的列列表与占位值、以及字段映射表中，相对位置一致。
- [ ] 读取缺失列时有默认值兜底，且该兜底经过断言：构造一个旧 schema 的数据库文件打开后，依赖该列的计数规则**确实生效**，而不是以「未定义」参与比较后被静默放过。
- [ ] 旧账本的历史订单、成交、期限与状态在打开后一字不改，不被重新解释。
- [ ] 原有「价差外」与「固定价」两个取值的含义与行为完全不变。
- [ ] 测试能力新建而非扩展：仓库现有测试从未构造过旧 schema 的数据库文件，也从未断言过迁移。新增测试需真实落盘一个旧结构的库再打开，不能只用内存对象模拟。

## Answer

实现完成并合并进集成分支 `feat/four-leg-maker-requote`（提交 `8df0606`，工作提交 `f187bbb`）。

**落地内容**

- 报价模式新增取值 `'best'`，语义为「初始挂同侧最优价，每次重挂按当时的同侧最优价重算」，并写入 `pair.price_policy` 的取值约束。取值同时扩到 `src/engine/types.ts` 的 `PairRow`、`src/engine/create.ts` 的 `DealRequest` 与 `resolveDeal` 归一化、`web/src/api/types.ts` 的 `DealPair` 与 `DealRequest`。
- `resolveDeal` 原本是二元三元表达式，任何非 `'fixed'` 的取值都会被静默降级成 `'touch'`——因此仅改前端不会报错，只会产生一个普通的 `'touch'` deal。已改为三值透传。
- 迁移新增 `pair` 表列探测分支（`reprice_count`、`last_maker_placement_at`，均 `INTEGER NOT NULL DEFAULT 0`），沿用「只做加法、不改写既有行」。
- `toPair` 对两列写入 `?? 0` 兜底，并断言其生效；注释记录原因：`undefined + 1` 是 `NaN`、`undefined >= cap` 是 `false`，改价上限会因此静默失效。
- 新测试 `tests/unit/engine-store-migration.test.ts`：真实落盘一个旧结构（两值 CHECK、无新列）的库文件，关闭后经 `Store` 重开，断言旧行一字不改、新列取默认值、旧 `orders` 行逐字段存活、`'best'` 写入成功、二次重开幂等。

**对工单前提的三处修正（后续工单需要知道）**

1. **加列分支不足以扩 CHECK。** `ALTER TABLE ADD COLUMN` 无法放宽既有 `CHECK`，只补列会让旧库打开正常、却在第一次写 `'best'` 时抛 `CHECK constraint failed`。SQLite 唯一可行路径是表重建（新建 → 拷贝 → 删除 → 改名），且必须以 DDL 探测守卫，使已扩宽的新装库跳过。
2. **`PRAGMA defer_foreign_keys` 对本重建无效。** 因为 `DROP` 是立即操作，而延迟约束只在 COMMIT 检查，`DROP TABLE pair` 仍会抛 `FOREIGN KEY constraint failed`。可用配方是事务**之外** `foreign_keys = OFF`，重建，`PRAGMA foreign_key_check` 校验，`finally` 里恢复 `ON`（该 pragma 在事务内是空操作）。代码注释已记录，避免被「简化」回去。
3. **CHECK 守卫必须读 `sqlite_master` 的 DDL 文本**，因为 `PRAGMA table_info` 不报告 CHECK 约束；列本身仍用常规 `table_info` 探测。重建按 `PRAGMA table_info(pair)` 的实际列集拷贝（而非硬编码列名表），避免静默丢列。

**刻意未做**

- `decide.ts` 与 `loop.ts` 未改动：当前代码下 `'best'` 走非 `'touch'` 分支，即不产生任何用户可见的报价行为变化，符合「本工单不改变用户可见报价行为」。
- `makerNotBefore`／`hedgeNotBefore` 未复用。它们是旧的反抖动拒绝退避，不是 15 秒「距上次挂单」事实；规格明确否定了这种复用。
- 未把两个新字段加进 web 的 `DealPair` 接口：服务端返回整个 pair 对象，运行时本就到达前端，而工单只要求 web 侧接受 `'best'`，UI 读数属工单 07。

**验证**

- `yarn typecheck` 通过；`yarn --cwd web typecheck` 通过。
- `yarn test`：115 文件 / 2686 通过、8 跳过（基线 114 / 2680，增量为新增测试）。
- `yarn --cwd web test`：100 文件 / 1458 通过。
- 未运行 `test:live`（会下真实订单）。

## Comments

### 2026-10-11 完成状态复核

结论：实现与离线验收已完成，顶部与正文状态统一为 `resolved`。原始验收清单和历史 Answer 保留。

旧 schema 文件迁移、缺列默认值、best CHECK、历史订单与期限、额外列/索引/触发器保留及重开幂等：engine-store-migration.test.ts。

核查实现提交 `36dbcaf`（含最终修复 `9f12669`）；核查结束时 HEAD 为 `1e42912`，其新增 stop 脚本未改本功能实现。当前重新运行 `yarn verify` 通过：根测试 122 文件 / 2840 通过 / 8 跳过，web 测试 100 文件 / 1469 通过，两项类型检查通过；`yarn --cwd web build` 通过。详细记录见 [review.md](../review.md#completion-status-recheck--2026-10-11)。

此状态不表示部署或实盘验证完成；[实盘验证清单](../live-validation-checklist.md) 尚未执行，不勾选其检查项。
