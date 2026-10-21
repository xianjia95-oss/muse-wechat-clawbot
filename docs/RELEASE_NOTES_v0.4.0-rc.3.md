# Muse Link v0.4.0-rc.3

修复旧 inbox pull/ack 在后台运行时被状态锁拒绝的兼容回归，改走后台 API；--offline 仍要求停服务。Muse adapter、HTTP/CLI 与 inbox pull CLI 默认单任务领取，显式批量仍可用，避免任务被预占却未处理。

stale_lease 保留原错误码与安全检查，新增 missing_token、token_mismatch、lease_expired、event_acknowledged 等具体原因、服务端时间与租约/ack 时刻。日志新增接收、领取、worker API 拒绝及 ack 来源；status/diagnose 展示等待领取、已占用任务、最近 worker 活动和出站阶段。

新增只读 scripts/diagnose.mjs，可对现有 rc.2 运行，无需 npm 安装或重启。可在云端对原 token 作本地比对，输出不含 token 和正文。muse next --output 将原始领取响应先保存为私密文件，拒绝覆盖旧交接记录，减少跨班次丢失 token；接班仍须确认旧 worker 停止并正常校验。新增 12 项真实 HTTP/CLI、进程锁兼容、脱敏、交接文件及独立进程重启回归。

这版修复已复现的兼容/领取问题并补足定位证据，不宣称已经定位或解决所有部署的间歇性拒绝。health 通过和历史 accepted 不能证明当前任务已回复。先按 docs/TROUBLESHOOTING.md 与 docs/给Muse排查无回复的指令.txt 采集实际事件；不要盲目清租约或重做外部动作。真实 hooks/手机和 72 小时验收仍须完成。
