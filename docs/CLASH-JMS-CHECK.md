# Clash Verge / JMS 连接检查

从仓库根目录运行，Python 3 标准库即可，无需安装依赖或配置订阅凭据：

```bash
python3 scripts/check_clash_jms.py
python3 scripts/check_clash_jms.py --json
```

脚本自动寻找当前 Linux 用户的 Clash Verge 服务 Unix 控制套接字，读取当前运行配置，
递归展开 `JMS` 组的全部成员，对去重后的每个实际节点分别做 Google HTTPS 探测，最多并发 6 项。
自动选择组中的重复节点只测一次；DIRECT、REJECT 等策略不算代理节点。
逐节点列出状态、延迟及是否当前选中，并汇总正常、失败、未知数量。
另外通过运行配置里的 HTTP/mixed 代理端口，分别访问 Google 和 Telegram 公共入口，
使用 HTTP CONNECT 并验证 TLS 证书，不受 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 干扰。
入口测试遵循当前路由规则，可能直连；逐节点探测分别确认每个 JMS 节点是否可达。
这些测试证明查询时的连接状态，不保证后续稳定性，也不验证 Telegram 消息送达。

自定义组、套接字或每项操作的超时：

```bash
python3 scripts/check_clash_jms.py --group JMS --timeout 5
python3 scripts/check_clash_jms.py --socket /run/clash-verge-service/users/1000/verge-mihomo.sock
```

- `OK` / 退出码 **0**：控制接口、全部 JMS 节点探测、两个代理入口测试全部通过。
- `FAIL` / 退出码 **2**：发现节点探测失败、非代理节点选择或入口连接异常。
- `UNKNOWN` / 退出码 **1**：没有已证实的失败，但有权限、控制接口或数据缺口，无法完整确认。

任一 `FAIL` 优先于 `UNKNOWN`；JSON 的 `complete=false` 表示仍有无法确认的检查项。
未知值不会替换为零。进程名称仅作辅助信息，最终结论以控制接口和实际网络探测为准。
嵌套组循环、成员缺失或空列表会令覆盖检查为 UNKNOWN，仍会探测已找到的其他节点；
任何备用节点失败也会令整体结果为 FAIL，即使当前选中节点仍能使用。
若在受限沙箱内出现 `PermissionError`，请在允许访问本机套接字和网络的环境重跑；
可用 `--socket` 显式指定路径，脚本不会为了检查连接而启动或重启 Clash。

仅查询状态并发起连通性探测；探测可更新 Mihomo 内存中的延迟记录。
不切换节点、不改配置、不更新订阅、不发送 Telegram 消息。
输出省略节点名称中的账号前缀，不打印代理密码、订阅 URL 或原始错误正文；
错误保留异常类型和可提取的 HTTP 状态码。

接口依据：[Mihomo 官方 API](https://github.com/MetaCubeX/meta-docs/blob/main/docs/api/index.en.md)。
离线验证：`python3 -m unittest discover -s tests/monitor -p test_check_clash_jms.py -v`。
