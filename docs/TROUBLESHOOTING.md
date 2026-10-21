# 微信很久不回复的排查

health 通过和最近 29 条 accepted 之类的历史指标，不能证明当前事件已提交回复。先区分微信接收、Muse 唤醒/领取、模型/工具处理、回复提交和腾讯确认。不要先删库、清租约、换 request_id 或关闭租约校验。

## 现有 rc.2 可直接采集

下载新源码到独立目录，不运行安装器，也不停止现有服务。Node.js 24 可直接运行这个只读脚本，无需 npm ci：

```bash
node scripts/diagnose.mjs
# 自定义配置须与实际 worker 一致：
node scripts/diagnose.mjs --config /private/config.json --event-id '<原事件ID>'
```

脚本只请求本机 status/health/metrics；指定 event-id 时还只读查询原 SQLite。它不领取、ack、续租、发送或重启，不输出配置凭据、消息正文或 token。rc.2 没有 worker 活动遥测，会明确显示 worker_telemetry_available=false，不虚构历史。

要核对原提交 token，请在云端把**原 worker 保存的值**作为标准输入提供，而不是回传聊天或放在参数中：

```bash
node scripts/diagnose.mjs --config /private/config.json \
  --event-id '<原事件ID>' --lease-token-stdin < '/private/captured-lease-token.txt'
```

文件只能有该 token 和可选末尾换行；不能从数据库抄当前 token 来冒充原 worker 的值。没有原记录时注明无法比较。supplied_token_check.lease_reason=null 表示检查时该 token 与当前数据库吻合且有效，不能据此证明过去失败时也相同。记录 checked_at_ms、acknowledged_at_ms、lease_until_ms 和 client_endpoint；确认领取/回复/诊断使用同一配置、HOME、命令包装器和后台端口。不要公开 token 文件。

## rc.3 的持续定位

```bash
muse-link diagnose
journalctl -u muse-link -n 100 --no-pager
```

- queue.ready > 0：消息入库等待 worker；查真实 hook 启用状态、实际间隔、执行命令和退出码，不是发送连接池在等长轮询。
- queue.leased > 0：任务已领取而未确认；ready=0 不代表处理完成。检查原 worker 进度和 next_lease_expiry_ms，不能盲目释放正在执行工具的任务。
- worker.last_reply_at 尚未出现：本次服务启动后未看到 muse reply，查 worker 是否先在主聊天结束、遗漏回传或提前 ack。API 被拒绝也会有 last_api_error，不能只看发送成功日志。
- delivery.queued / uploading / sending：回复已进入桥，分别定位同收件人排队、媒体上传或腾讯 chat 请求；oldest_inflight_ms 是已提交工作的最长等待。accepted 不等于手机显示。
- task_acknowledged 日志的 source 区分 explicit_ack、final_reply 和 accepted_recovery；用稳定 request_id 关联日志，不记录正文、token 或微信账号。

## stale_lease 的具体含义

| lease_reason | 核对及处理 |
| --- | --- |
| missing_token | 未带 token 或为空；使用此次领取保存的 token，不能从别的任务/全局变量复制。 |
| token_mismatch | 提交值与当前事件记录不一致；查重复 worker、配置/后台错配和原始领取输出。普通 claim 不会覆盖尚未到期的租约，不能直接归因于重启。 |
| lease_expired | 服务器判断已到期；记录 server_time 与 lease_until。确认旧 worker/外部工具状态后重新领取，复用原结果与稳定 ID，不重做生成或外部操作。 |
| event_acknowledged | 事件已确认；查 acked_ms 与 ack 来源。不能在最终回复之前先 ack；不要为了补回消息直接改数据库。 |
| event_not_found / invalid_event_id | 查 event_id、配置/端口和历史保留；不要认作“网络慢”。 |

若领取后十几秒就被拒绝，而 lease_until 在 30 分钟后，仅凭旧版的 stale_lease 无法判断过期。需要失败时的具体 reason、服务端时间、ack 和配置证据。保留脱敏的原始错误 JSON、退出码和领取记录，不仅回传自然语言判断。后续其他任务成功不能排除某个事件的交接问题。

若新班次说没有保存上一班的 token，原 token 与数据库是否相同就是未知，不能同时断言“没有拿错”。这能解释新班次为什么无法继续旧任务，不能证明首次提交为何被拒绝。将“首次拒绝原因待查”和“交接丢失，未到期任务暂不能重领”分别记录。rc.3 增加 `muse next --output /private/new-task.json` 的私密领取结果保存，完整流程见 [跨班次交接](MUSE.md#跨班次交接)。旧服务仍保持原租约保护，不通过读库强行接管。

精确 v0.4.0-rc.2 源码的本地独立进程复现中，“先重启再领取回复”和“领取后重启再用原 token 回复”均成功；重启会重开 SQLite 和状态锁，mock 仅替代腾讯上游。它排除了这两条简单路径的必现故障，不能证明云端特定事件没有其他缺陷。服务重启早于领取，且没有失败时的 token 比对记录时，不能把原因写成“重启使租约残留”。

## 已修的兼容陷阱

v0.4 增加进程状态锁后，原 inbox pull/ack 曾在运行中误走离线数据库，返回 state_locked。rc.3 改为默认走后台 API，显式 --offline 仍拒绝活跃服务；租约 token 检查继续保留。旧 worker 还须使用当前 token，不能只升级接收后台。

此前 Muse 默认一次可领取 20 条，单次 worker 如果仅处理一条，其余可能在默认 30 分钟内不再触发 ready 唤醒。rc.3 的 Muse adapter、HTTP/CLI 与 inbox pull CLI 默认只取一条，批量必须显式指定。已有租约不自动清空；长任务按约定续租。普通问候无需 checkpoint；会改变外部状态或不应重复的工具才记录 started/completed。
