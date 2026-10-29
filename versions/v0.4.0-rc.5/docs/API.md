# Muse Link HTTP API

默认地址 `http://127.0.0.1:18791`；除 `/healthz` 外，均须 `Authorization: Bearer <config.api_token>`。配置由 `muse-link init` 自动生成。只允许绑定 loopback。

## Muse 任务接口（推荐）

这些接口运行在桥上，由真实 Muse 在其原生 hooks 中调用，并非 Muse 官方模型 API。

`GET /v1/muse/tasks?limit=1&lease=30m&wait=0s` 领取任务，默认 limit=1，返回 `{"tasks":[...]}`。任务包含原始事件字段、lease_token、lease_until、execution.steps / execution.needs_review 及 completion，其中 request_id 为最终回复的固定编号，state 为 not_submitted / pending / accepted / rejected / unknown / failed。同一租约参数范围与下方收件箱接口相同。读取不会自动执行 Muse 任务。

rc.4 遇到已经 accepted、但 ack 尚未完成的恢复记录时，会确认该记录后继续寻找真实待处理任务；不会仅因这一批全是恢复项就返回空数组。长等待沿用原时限，取消仍不会占用后续任务。limit=1 只表示单次领取量，不表示必须全局串行等待外部工具。长工具后台处理和只读逐条核查见 [BURST_MESSAGES.md](BURST_MESSAGES.md)。

本地构建 `rc5-inbound-media-20261028` 的任务还包含实时 `media` 状态。图片/视频/语音后台下载，领取不等待文件。新增 `POST /v1/muse/media`，JSON 为 `{"event_id":"本次事件","lease_token":"本次完整原token","retry":false}`；API 认证及有效原事件租约均必需，返回 `media` 的 queued/downloading/ready/failed 和 ready 文件的私密 path、mime_type、size、sha256。语音可能含原文件 raw_path 与 conversion_error。该查询不 ack、不续租、不返回 CDN 票据和解密密钥。显式 retry 只重排失败项，累计最多三次；恢复审查期间拒绝。最终回复遇到未下载完的附件返回 `inbound_media_pending`，不创建发送意图、不 ack。普通诊断不返回附件路径。详情见 MEDIA.md。

最终回复 `POST /v1/muse/replies`：

```json
{
  "event_id": "muse:example-event",
  "lease_token": "领取该任务时返回的 token",
  "text": "Muse 的处理结果"
}
```

桥从已领取的事件中查找收件人，自动生成稳定 request_id。微信确认全部文字分段及媒体消息后，才 ack 事件；响应包括 state=accepted、event_completed=true 和 timing。若网络不确定或发送被拒绝，保留事件且不自动重发。崩溃发生在发送成功、ack 之前时，后续 muse/tasks 会依据持久化发送结果完成事件，避免再次交给 Muse 执行。

rc.5 新增可选 `"async":true`（布尔值；CLI 为 `--async`）。桥先验证并持久化发送意图，返回 HTTP 202、submitted=true、state=pending、request_id、event_completed=false；这仅表示已提交后台。使用 `muse-link request '<request_id>'` 查询持久化回执，只有 accepted 才结束结果通知。已经 accepted 的缓存回复仍返回 200。异步最终回复在全部消息 accepted 后自动 ack；失败或 unknown 保留事件，并产生安全告警。默认同步调用保持原行为。

异步发送在同一 daemon 内执行，不是持久化的自动重试队列。进程强制中断后结果按现有恢复规则核对，不能认为仍在后台发送。调用方须保存原任务、原文字/媒体路径和稳定 request_id；pending 时继续续租、处理其他消息，并逐轮查询回执，不能同步循环等这一项。unknown/rejected 不自动重发，failed 仅在核对后以原请求显式续传。

v0.4.0-rc.5 可附 `"media":[{"type":"image","path":"/absolute/result.png"},{"type":"video","path":"/absolute/result.mp4"}]`，有媒体时 text 可省略。最多 4 个，仅接受桥所在机器上的绝对路径，并检查 config.media_roots。图片 20 MiB、视频 50 MiB 本地上限。桥按文字分段、media 数组顺序发送；CLI 多个 --image 排在多个 --video 前。详见 [媒体说明](MEDIA.md)。

进度回复额外传 `"mode":"progress","reply_id":"started"`。progress 需要每条进度的稳定 reply_id，成功后不结束任务。最终回复 mode 默认为 final，不能指定 reply_id、to、binding 或 request_id，避免更换编号绕过去重或发错用户。两个模式均支持可选 model_ready_at。

同一最终回复重复提交相同文字及媒体类型/路径，返回缓存并修复未完成的 ack；更换文字、媒体类型或路径重用最终回复会报 ID 冲突。媒体 ID 绑定首次成功准备的文件快照；原路径后续内容变化不会替换已有快照，成功后重试返回旧结果。unknown 需核对微信及在 Muse 聊天报告，不能另起编号盲目重发。需要主动结束未发送的任务或处理 alert 时，报告并持久化结果后再调用 events/ack。外部任务本身的执行去重仍需由 Muse 按 event_id 记录进度。

命令行对应：`muse-link muse next`、`muse-link muse reply EVENT_ID --lease-token '<lease_token>' --text -`、`muse-link muse ack EVENT_ID --lease-token '<lease_token>'`。保留以下底层发送接口用于诊断。

rc.3 的 next 支持 `--output /private/new-task.json`。请求前独占创建 0600 文件，父目录须私密且不经过符号链接；先保存原始领取响应并 fsync，再输出。不能覆盖旧记录。文件含原 token 和消息正文，只用于本地交接；收到成功响应但保存失败时，退出非零并在 stdout 保留响应供原 worker 私密保存。不能只凭文件存在就执行任务，应检查 claim_state=response_saved 与 tasks，并按 [交接流程](MUSE.md#跨班次交接) 确认旧 worker 停止、校验租约和核对工具进度。

## 即时回复

`POST /v1/send`，Content-Type 为 application/json：

```json
{
  "request_id": "muse:123:reply:final",
  "to": "wxid_from_incoming_event",
  "text": "任务结果"
}
```

request_id 必填，也可用 Idempotency-Key 请求头传递。binding 可省略，提供时须与本实例一致。文本最多 32000 个 Unicode 码点，每 2000 个码点一条，按顺序立即发送。此接口同样可附 media 数组回传图片/视频，不发送普通文件或原始语音。

可选 `model_ready_at` 是客户端记录的真实结果就绪时间（Unix 毫秒）。不提供则对应耗时为 null；不要将调用工具时刻冒充模型完成时刻。

成功返回 200，包括 ok=true、state=accepted、request_id、accepted_chunks、total_chunks、accepted_parts、total_parts、media_count、accepted_at 和 timing。chunks/parts 均计数实际消息（文字分段和媒体消息各算一条），media_count 计数附件。accepted 表示微信接口已返回成功，不能确认手机显示或视频播放；当前协议没有手机送达回执。

| timing 字段 | 含义 |
| --- | --- |
| model_to_submit_ms | 客户端声明的结果就绪到桥收到请求的间隔，依赖准确记录与同机时钟。 |
| queue_ms | 各分段等待同一收件人实际 chat 提交通道的累计时间，不含媒体上传。 |
| upstream_ms | 上传参数、CDN 上传及消息发送的累计耗时；纯文字等于消息发送耗时。 |
| media_prepare_ms | 检查并流式加密媒体快照的耗时。 |
| media_upload_ms | 获取上传参数和向 CDN 上传的耗时，含上传重试。 |
| send_message_ms | 文字及媒体 sendmessage 请求的累计耗时。 |
| first_chunk_ms | 桥收到本次请求后，第一段获得微信接口成功确认的时间。 |
| bridge_ms | 桥处理此次请求到发送完成的时间，含排队、持久化和网络。 |

model_to_submit_ms 很大时检查 Muse 何时调用发送工具；upstream_ms 很大时检查云端网络和代理；queue_ms 很大时检查前面是否有长回复。收消息与发送使用独立连接池；已经提交的回复不等待收件箱轮询或 hook。腾讯协议说明 getupdates 在有消息或超时后返回，35 秒通常是长轮询等待上限，不是每条回复固定增加的耗时。

## 结果查询和重试

`GET /v1/requests/<request_id>` 返回 state 和 result。相同 ID 和内容的并发请求合并；成功后再次提交返回缓存；换内容复用 ID 返回 409。同一收件人的实际 chat 调用串行，媒体准备/上传不占该通道。每个请求内部的文字、附件保持原顺序；不同请求可交错，后提交的短文字可能先于正在上传的图片到达。不同收件人可并行。

| 状态 | 处理 |
| --- | --- |
| pending | 排队或发送中，查询或用相同 ID 和内容等待结果。 |
| accepted | 所有分段已获得微信接口确认。 |
| rejected | 微信明确拒绝某个分段，先查看 accepted_chunks。 |
| unknown | 网络、响应解析或进程中断导致结果无法确认，不自动重发，先报告并核对微信。 |
| failed | 文件准备或媒体上传失败，当前媒体消息尚未提交，result.retryable=true；修复原因后用同 ID、文字和媒体路径续传，跳过已确认的消息。不要重做整个 Muse 生成任务。 |

请求超时不能换新 ID 盲目重试。服务发送前持久化分段状态，重启后把未确认的发送标为 unknown。微信服务端 client_id 去重行为未经实测，本项目不声称任意故障下“恰好发送一次”。

CDN 上传在 media_timeout_ms（默认 120000）总时限内最多尝试三次，4xx 立即停止；这些请求不发送聊天消息。sendmessage 超时仍按 unknown 处理。failed 不会由后台无限重试；需调用方核对并以原请求显式续传。

常见 HTTP 错误：400 参数错误，401 token 错误或微信登录过期，403 不在白名单，409 缺少上下文 / ID 冲突 / 旧请求需核对，413 文本过大，502 微信拒绝或结果不明。错误有 error、message；部分成功时附 accepted_chunks。

## 收件箱与状态

- `GET /v1/events?limit=20&lease=30m&wait=30s`：领取。limit 1..100、lease 1 秒..1 小时、wait 0..60 秒；等待请求有事件时立即返回。
- `POST /v1/events/ack`：正文 `{"event_ids":["muse:123"],"lease_token":"当前领取 token"}`；多事件不同 token 用 lease_tokens 对象按 event_id 映射，处理完确认。
- `GET /v1/status`：version、build、capabilities、登录、接收状态、收件箱数量、发送中请求数；本地增强包应显示 version=0.4.0-rc.5、build=rc5-inbound-media-20261028、capabilities.receive 含 image/video/voice，send 含 image/video。
- `GET /v1/metrics`：最近 300 请求的状态计数，以及成功请求耗时 p50/p95。失败和 pending 不混入成功耗时。
- `GET /healthz`：进程存活；微信连通性看 status 或 muse-link health。

事件按 event_id 去重，领取有租约。会话、上下文、事件和发送状态在 state_dir 的 SQLite 中。接收批次的事件、上下文和游标原子提交。入站文本和微信语音转写可读；暂不支持的附件通过 media_errors 报告。

空或非字符串 get_updates_buf 不覆盖已有游标；HTTP 200 的空白响应不是 JSON 成功回执，chat 发送会保持 unknown、不 ack、不自动重发。有效 JSON `{}` 保持腾讯协议的兼容行为，不要求必须含 ret。

## 生产候选版的租约、步骤与健康

默认 require_lease_token=true。回复、进度、ack、续租和 checkpoint 使用当前有效租约；旧 token / 已过期 / 已确认事件返回 409 stale_lease。已经 accepted 的相同回复可读取缓存，无需重新触发发送。底层 send 没有 Muse 执行语义，仅供受信诊断调用。

rc.3 的 stale_lease 带 lease_reason（missing_token / token_mismatch / lease_expired / event_acknowledged / event_not_found / invalid_event_id）、server_time，存在事件时带 lease_until 和 acked_ms。时间均为 epoch 毫秒，不返回 token。保持原错误码兼容，不能把所有 stale_lease 统称为租约过期。

`GET /v1/diagnostics` / `muse-link diagnose` 只读返回队列、worker 活动、最近拒绝原因和发送阶段；worker 计数自本次服务启动起有效，成功的同类调用会清除对应最近错误。status 也增加 queue、worker、delivery。旧 inbox pull/ack 默认使用 API，--offline 须停服务；底层 GET /v1/events 保持默认 20，CLI inbox pull 默认 1。详见 [无回复排查](TROUBLESHOOTING.md)。

- `POST /v1/muse/renew`：`{"event_id":"muse:123","lease_token":"...","lease_ms":1800000}`，1 秒到 1 小时，返回新的 lease_until，token 不变。
- `POST /v1/muse/checkpoints`：`{"event_id":"muse:123","lease_token":"...","step":"tool-action","phase":"started","result":null}`；工具完成后同 step、phase=completed，result 最多 16 KiB。完成的步骤返回 cached=true，应跳过工具。重投后的 started 无法再次开始，需核对后用 reviewed=true 完成记录；遗留 started 阻止最终回复和 ack。步骤和外部系统不在同一事务，不能保证外部动作恰好一次。
- `POST /v1/requests/<id>/review`：`{"reviewed":true,"note":"核对记录，最多1000字符"}`。仅允许 unknown，状态仍为 unknown，resend_allowed=false；此操作解除未核对告警，不授权重发。
- `GET /v1/health`：认证的 readiness，200 healthy=true 或 503 healthy=false；problems、queue、storage 及 status。检查轮询新鲜度、存储、积压、未知发送、遗留工具步骤和恢复闸门。

领取、续租、checkpoint 会持久化刷新事件的 lease_activity_ms。queue 增加 stalled_leases、oldest_lease_activity_ms；活跃租约超过 operations.worker_stale_ms（默认 10 分钟）没有上述活动时，health 返回 worker_lease_stalled。它是待检查提示，不证明 worker 已死亡，不修改或抢占租约；旧记录无活动字段时保守使用接收时刻，正常续租后刷新。

容量满返回 429 queue_full / 503 http_capacity 或 inbox_full，存储预算返回 507 storage_pressure，维护/停机排空返回 503；429/503/507 带 Retry-After:5。检查 request 后再决定是否用相同内容重试。具体预算、90 天幂等保留窗口、恢复后的强制核对、备份与上线条件见 [生产运行](PRODUCTION.md)。
