# 01: 本机地址别名保持风险证据一致

**What to build:** 使用 localhost 或 127.0.0.1访问同一端口的本机终端时，风险页和后台报告接受同一份有效监控证据；其他账号、钱包、子账户、端口及配置仍严格隔离。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Progress:** resolved

- [x] 回环地址别名产生相同风险判定，不再造成服务与心跳 UNKNOWN。
- [x] 历史配置指纹和已保存状态保持兼容；真实身份、端口或配置不匹配仍拒绝。
- [x] 缺失、过期或未来时间的证据仍为 UNKNOWN。
- [x] 通过只读 API 回归验证，不更改交易、认证或监听边界。

## Answer

已完成，实现与验收见同目录上级 acceptance.md。双轴审查均无实质问题；仅完成源码/离线验收，实时终端未重启。
