# 01: 将缺失中间利率统一视为 UNKNOWN

**Type:** task

**Status:** ready-for-agent

**Progress:** resolved

**What to build:** 展期盯盘、批量技术预检和 Risk 消费结果遵守普通利率市场的缺失值约定：上游用 0 表示缺失的 mid APR 时，显示 UNKNOWN，不误报超限，也不凭缺失证据判定预检通过。保留真实负利率的有效性。

**Blocked by:** None (can start immediately).

**Confirmed reproduction:** 将旧腿 mid APR 设为 0，报告将最大退出偏离算成 5.36%，误报超限；在另一组完整预检中，仅将一腿 mid 设为 0、exec 设为 0.001，批量技术预检仍返回通过。

- [x] 缺失、非有限或以 0 编码的普通市场 mid APR 均记为 UNKNOWN，不回退使用 mark 或其他利率。
- [x] 相应逐腿偏离、依赖它的 X_max 和滑点门禁保持 UNKNOWN；不得把缺失证据解释为真实超限或通过。
- [x] Python 与 TypeScript 的批量技术预检对同一合成输入给出一致结论；Risk 不展示由该缺失证据产生的绿色通过状态。
- [x] 合法负 mid APR 与负执行 APR 仍按实际差值检查；不对所有 APR 字段一律禁用 0。
- [x] 离线回归覆盖 mid=0、字段缺失、非有限值、合法负利率，以及 mid 缺失但 exec 落在容忍数值附近的误通过场景。
- [x] 退出 0.005、新开 0.0025 的现行容忍保持不变；验证不访问真实账户、不签名、不发送交易。

## Answer

2026-10-18：报价采样将普通市场的零 mid 归为缺失；Python/TypeScript 批量技术预检要求 mid 有限且非零，exec=0 和合法负率保持有效。未修改容忍、profile、下单逻辑。

- RED：新增 Python 回归在 mid=0 时得到 0 而非 None；TS 回归在 mid=0、exec=.001 时误返回 ready=true。
- GREEN：独立 Python 回归 3 项通过；Python/TS parity 文件 2 项通过（新增 10 种 mid/exec 情景）；`yarn typecheck` 通过。
- 待集成：Risk 消费端的 UNKNOWN 展示和禁止绿色通过，由主代理完成服务边界回归后核销剩余验收条件。

集成验收（2026-10-18）：Risk 服务边界的 mid=0/null 回归确认全量与候选批量状态为 UNKNOWN，未呈现绿色通过。Python/TS 对照与服务回归全部通过，剩余验收已闭合。

最终验收（2026-10-18）：Standards 与 Spec 双轴复审均无剩余必修项；yarn verify 通过（后端3188通过/8跳过，前端1586通过），monitor143通过，screening43通过，UI生产构建通过。仅离线验证，无真实账户或交易调用。
