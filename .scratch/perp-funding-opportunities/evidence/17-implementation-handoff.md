# 工单17实施交接

目标：旧仓只认领用户选定的当前可证数量，不交易、不倒填。14、17均已获用户签收并resolved，随本次本地提交归档；未启用交易。Positions新增独立认领入口，即使历史收益不可读仍可核验数量；切片资金费、费用、实际利润与权益收益率保留UNKNOWN，账户汇总继续独立展示。

账本步骤6增加认领命令表并同步安装器支持版本。预览/确认分别新读，遵守10秒期限；routes只记录意图并wake，正常loop每轮最多处理一条、读取最多等1秒，再原子建立as-of切片及逐腿认领。重复、并发、迟到、刷新均查询原身份；未确认预览可显式废弃，不撤销已接受认领。新基线锚定此前实成，避免同毫秒旧成交被重复补记。

Boros保存root/子账户/bucket/市场/到期/单位及来源，Spread物理份额只记一次；必须连接owner且数量、占用完整。非base抵押单位保持未证明，既有分配不静默释放或转移。外部差异保留，12准入和16 Risk仍独立校验。

验证：默认完整`yarn verify`通过，服务端3584通过/8跳过，Web1785全通过；production build通过。日志：`/tmp/ticket17-verify6.log`、`/tmp/ticket17-build.log`。此前失败记录保留于verify2—5：补齐安装器账本版本契约；两项既有测试改为完整800ms测试时钟、真实查询分阶段等待，未放宽超时或并发。修复后的聚焦日志为`pair-clock.log`、`setup-ready-final.log`（均有`/tmp/ticket17-`前缀）。

待办：本票无实施待办；后续工单另行认领。核心入口：`src/engine/slice-claims.ts`、`src/server/routes/sliceClaims.ts`、`web/src/panels/assets/StrategyOwnership.tsx`。图覆盖检查和实际源码均已核验；`git diff --check`通过。用户仅授权本地提交，未push或部署。
