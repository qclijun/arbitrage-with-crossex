# 工单01验收与审查

基线：`d5d901af94837724790f8ab73f3ca59a78adfc71`。2026-10-31 完成离线验收；当前分支 `dev`，本票不实现02的刷新公平性和回填调度。

## 行为与口径

- 为经原生产品资料和 CrossEx 符号共同核实的 HL BTC/ETH 增加资产身份；其 oracle 资金费基准独立保留。别名、HIP-3、包装资产及错误单位不能取得本票的跨基准配对资格，HYPE 仍未认证。
- 四场所同币齐备时，每币十二个唯一有向组合，包含 ETH 空HL/多OKX及反向。已有 CEX 组合的五窗口数值与相对顺序不变；零值、负值保留。币种/场所/正收益筛选及按同一指纹分页覆盖到新增方向。
- 沿用周期推算与共同截止点检查；小时和八小时结算各自汇总后相减。缺期、冲突、分页失败、陈旧或不同截止点不被提升为完整历史；长窗口失败不影响已完整的短窗口。
- `rateEstimate` 在 API 和页面标出每腿 oracle/mark、USDC/USDT 结算口径。估算为相同名义金额的费率差，不计各期价格、FX、基差或成本，不表示实际现金或权益收益。
- 服务端预检与接受时的重新判断独立检查计价差异，返回 `funding-valuation-unnormalized`，不提供可接受预检ID、现金场景或现金金额；页面只供观察。正常开仓回归使用 Binance/OKX 同基准样本，HL/OKX 两方向保留明确阻止测试。开仓开关逻辑保留。

## 验证

- 红绿回归覆盖公开配对入口、真实 `app.inject()` API、页面和执行阻止；确定性样本中 HL 每小时 0.00002，OKX 每八小时 0.0001，7天差额 0.00126、简单年化 0.0657，反向符号相反。该数值是合成验算，不能当成当前市场收益。
- `env GATE_PROXY= yarn verify` 退出0：后端194文件、3733通过/8跳过；前端120文件、1793通过；包含两端类型检查和全树文件大小检查。
- `yarn --cwd web build` 退出0。保留现有构建体积提示，无构建错误。
- 首轮普通 `yarn verify` 被本机代理干扰网络模拟，并发现一个要求所有HL资产身份未知的旧断言。已修正断言为BTC/ETH认证、HYPE未认证；清空测试进程代理后全量通过，未修改本机代理配置。
- 隔离浏览器使用合成BTC/ETH、真实API和生产UI；仅该内存样本开关打开。ETH+HL筛选显示六方向，正收益筛选显示两方向；选中空HL/多OKX显示估算说明且没有开仓表单。桌面1600px、手机390px无整页横向溢出，桥接统计写请求为0。未重启线上服务，未发送交易请求。
- 完整日志及截图仅在本机：`/tmp/funding-hl01-verify-final.log`、`/tmp/funding-hl01-build.log`、`/tmp/funding-hl01-desktop.png`、`/tmp/funding-hl01-mobile.png`。临时浏览器脚本已由既有 `.gitignore` 过滤。

## Standards

独立规范审查：0项硬性违反、0项未解决代码气味。曾发现身份测试标题与新断言相反，已修正并复核。审查范围含领域策略、只读看板、服务端预检、页面与迁移测试；无执行引擎或账户写入变更。

## Spec

独立工单审查：0项缺失、错误实现或越界。已核对十二方向、五窗口、估算口径、筛选分页、CEX值保留、页面说明和服务端阻止；另复核旧HL身份断言的更新。02调度未纳入。

合计：Standards 0项未解决问题；Spec 0项问题，两轴均无未解决最严重项。

## 产品依据

- [HL合约规格](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications)：原生合约按标的单位计量；BTC/ETH的USDT价格与USDC结算存在quanto口径。
- [HL资金费公式](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)：oracle价格参与资金费支付。
- [OKX资金费公式](https://www.okx.com/en-us/help/perps-funding-fee-mechanism)：线性合约名义价值按mark价格计量。

正式工单：[01](issues/01-hl-directed-pair-rankings.md)。
