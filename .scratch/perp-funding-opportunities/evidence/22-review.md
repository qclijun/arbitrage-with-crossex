# 22 双轴代码审查

基准：`53fdee2bac5c9e1f7dd0fb85415c700640423c42`，用户明确确认；审查对象为本票全部工作区/暂存 diff（含新增文件），适配 implement 技能的先审查后提交顺序。按 code-review 技能由两个 fresh-context agent 独立审查。默认完整验证由主 agent 执行，不以审查或 focused 测试替代。

## Standards

初查1项：公开探针 main 函数体未遵循项目两空格缩进（development.md）；已修正并复审。最终0项未处理的硬规范违规或有证据支持的结构异味；金额/数量仍为十进制字符串，认证、引擎写入边界及人工开仓开关未改。详细工作报告：`/tmp/issue22-standards-review.md`。

## Spec

初查3项实现问题，均已修复并复审：

1. 通用 schema URL + 熟悉 ticker 不能证明经济身份。改为六个精确产品的经济名称、官方资产/项目引用和产品单位证明表；Aster/HL/HYPE 等未核实项继续 null，并保留独立 mappingEvidence。
2. HL 当前“每小时”说明不能从时间零回填历史规则。生产全部缺少历史生效证明的 rules 均为空，不读历史凑完整性。
3. MBX 权重头原来只有字符串留档。现在解析数值，与正文声明的同周期分钟容量核对，在保守阈值冷却；不混用500/5min资金费计数器，并添加离线回归。

HL分页疑问经新增官方 info-endpoint Pagination 文档解决（500 elements/distinct blocks、末时间游标），见[公开记录](22-public-samples.md)及07补充。最终剩余代码缺陷0、范围扩张0。详细工作报告：`/tmp/issue22-spec-review.md`。

公开限流校准仍为 PARTIAL/UNKNOWN：当前出口 Binance451、Bybit403，未观察 Retry-After 或真实429/418；并未主动耗尽共享IP额度。这一限制不能被离线fixture、完整verify成功或UNKNOWN回退转换为“五源公开校准全部通过”。历史周期、HL上市/毫秒映射及尚无独立经济证明的产品继续阻止相关能力。受限实现可按工单UNKNOWN约定交付，完整公开证据验收仍未满足。

审查汇总：Standards 0项未处理；Spec 0项未处理代码问题，公开校准证据仍受限。

完整门禁另暴露既有 UserGuideHint 已挂载状态竞态，修复及两项先红后绿的组件回归见[门禁修复记录](22-full-gate-repair.md)。两个审查 agent 均复核无问题，属于必要的完整门禁修复，没有调整测试并发/超时。

主agent最终默认完整`yarn verify`退出0：后端177文件3614通过/8跳过，前端117文件1788通过（`/tmp/issue22-verify-clean.log`）；production build退出0（`/tmp/issue22-web-build-final.log`）。零成交用例的第二轮瞬态失败仍按门禁记录标明未复现，不宣称已修复其根因。

用户最终选择按UNKNOWN签收22实现；未完成公开校准移至[23](../issues/23-public-history-calibration.md)，21新增23依赖。签收不改变公开证据的PARTIAL/UNKNOWN结论。
