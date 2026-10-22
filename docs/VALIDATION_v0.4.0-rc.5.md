# v0.4.0-rc.5 修复与验证

日期：2026-10-22。本版修复上一轮审计发现的 2 项 P1、3 项 P2；验证均在隔离的本地模拟环境完成，不使用真实微信凭据或 Muse 云端。

| 问题 | 修复与回归证据 |
| --- | --- |
| P1 空白 HTTP 200 被误判为成功并 ack | 空/空白 JSON 解析失败，发送保留 unknown，事件不确认，同 ID 不重复发送；有效 JSON `{}` 和 ret=0 兼容。覆盖真实 Ilink → Bridge → Muse 路径。 |
| P1 监督器被杀后孤儿 job 长期占满容量 | reviewed reconcile 检查启动锁、监督锁、Linux 进程身份和原工具组；活跃时拒绝。退出后记录 interrupted，原 ID 去重继续生效，释放活动名额，仍需业务核对/结清通知，不操作微信事件。 |
| P2 空游标覆盖有效游标 | 缺失、空、非字符串游标不覆盖已提交值，事务仍覆盖事件、上下文和游标。 |
| P2 有效租约卡住但健康检查不报 | 领取/续租/checkpoint 持久化活动；长期无活动时 health/diagnose 报 worker_lease_stalled，续租可解除。新领取旧消息不误报，重开 SQLite 保留活动，检查不更改 token/租约或 ack。 |
| P2 慢媒体阻塞同聊天短回复 | 媒体准备/上传移出实际 chat 通道；真实 HTTP API/CLI 用 --async 提交媒体，上传受控挂起时，同一个串行 worker 完成 5 条短消息；媒体完成前不 ack，全部 accepted 后自动 ack，重复提交不重复上传。 |

后台启动额外覆盖：只有元数据写盘与目录 fsync 完成后才通过 IPC 授权可信脚本执行；缺少授权、监督器断开、迟到授权与迟到监督器均不能执行已结案脚本。PID 复用不隐藏孤儿；缺身份旧记录保守拒绝。私密核对说明不出现在 list/start 缓存输出。回归也覆盖超时、输出上限、取消、上传后租约失效、unknown 禁止盲目重发、优雅停机等待异步发送和最终 ack。

## 本地结果

- Windows / Node 24.14.1：102 项，93 通过、9 项仅 Linux 测试跳过、0 失败。
- Linux / Node 24.22.0：102 项全部通过；最终孤儿记录边界修改另跑 9 项 Linux 工具回归，全部通过。
- Linux 安装冒烟：安装、失败隔离、运行中拒绝、升级备份、回滚、私密配置与真实 hook 脚本均通过；systemctl 使用隔离测试替身。
- 本地 HTTP + SQLite demo 通过；60 秒持续压测完成 1,704 个任务、1,704 次缓存重试、8 次进程内服务重建，零重复上游消息。包含领取、checkpoint、续租、最终回复和恢复；本地模拟耗时不代表真实微信速度。
- npm audit --omit=dev：0 已知漏洞；git diff --check 通过。未新增运行依赖。

本地日志在未公开的 dist/fix-rc5-windows-tests.log、dist/fix-rc5-linux-smoke.log、dist/fix-rc5-final-jobs-linux.log、dist/fix-rc5-npm-audit.json。发布前须核对精确提交的 Windows/Linux CI、安装作业及源码包；Release 附源码 ZIP 和 SHA256，不替换已有 rc.4 资产。

## 必须在部署中继续验收

按 [升级指令](给Muse升级的指令.txt) 同时更新 daemon 与真实 worker/hook，尤其是 --async、逐轮回执检查、续租和工具结果处置。只更新服务不改变 Muse 同步等待工具或上传的行为。

按 [生产验收指令](给Muse生产验收的指令.txt) 验证真实 hooks、手机文字/图片/视频、长工具和慢上传期间连发短消息、故障/备份/回滚以及实际 72 小时运行。本地未访问云端，不代表线上问题已经修复或已经达到生产验收标准。pending 不是手机送达；不同任务可交错回复；强制终止后不会自动重发未决异步发送。
