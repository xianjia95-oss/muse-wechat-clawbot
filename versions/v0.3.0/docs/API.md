# Muse Link HTTP API

默认地址 `http://127.0.0.1:18791`；除 `/healthz` 外，均须 `Authorization: Bearer <config.api_token>`。配置由 `muse-link init` 自动生成。只允许绑定 loopback。

## Muse 任务接口（推荐）

这些接口运行在桥上，由真实 Muse 在其原生 hooks 中调用，并非 Muse 官方模型 API。

`GET /v1/muse/tasks?limit=20&lease=30m&wait=0s` 领取任务，返回 `{"tasks":[...]}`。任务包含原始事件字段及 completion，其中 request_id 为最终回复的固定编号，state 为 not_submitted / pending / accepted / rejected / unknown / failed。同一租约参数范围与下方收件箱接口相同。读取不会自动执行 Muse 任务。

最终回复 `POST /v1/muse/replies`：

```json
{
  "event_id": "muse:7523456789012345678",
  "text": "Muse 的处理结果"
}
```

桥从已领取的事件中查找收件人，自动生成稳定 request_id。微信确认全部文字分段及媒体消息后，才 ack 事件；响应包括 state=accepted、event_completed=true 和 timing。若网络不确定或发送被拒绝，保留事件且不自动重发。崩溃发生在发送成功、ack 之前时，后续 muse/tasks 会依据持久化发送结果完成事件，避免再次交给 Muse 执行。

v0.3.0 可附 `"media":[{"type":"image","path":"/absolute/result.png"},{"type":"video","path":"/absolute/result.mp4"}]`，有媒体时 text 可省略。最多 4 个，仅接受桥所在机器上的绝对路径，并检查 config.media_roots。图片 20 MiB、视频 50 MiB 本地上限。桥按文字分段、media 数组顺序发送；CLI 多个 --image 排在多个 --video 前。详见 [媒体说明](MEDIA.md)。

进度回复额外传 `"mode":"progress","reply_id":"started"`。progress 需要每条进度的稳定 reply_id，成功后不结束任务。最终回复 mode 默认为 final，不能指定 reply_id、to、binding 或 request_id，避免更换编号绕过去重或发错用户。两个模式均支持可选 model_ready_at。

同一最终回复重复提交相同文字及媒体类型/路径，返回缓存并修复未完成的 ack；更换文字、媒体类型或路径重用最终回复会报 ID 冲突。媒体 ID 绑定首次成功准备的文件快照；原路径后续内容变化不会替换已有快照，成功后重试返回旧结果。unknown 需核对微信及在 Muse 聊天报告，不能另起编号盲目重发。需要主动结束未发送的任务或处理 alert 时，报告并持久化结果后再调用 events/ack。外部任务本身的执行去重仍需由 Muse 按 event_id 记录进度。

命令行对应：`muse-link muse next`、`muse-link muse reply EVENT_ID --text -`、`muse-link muse ack EVENT_ID`。保留以下底层发送接口用于诊断。

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
| queue_ms | 等待同一收件人上一条发送完成的时间。 |
| upstream_ms | 上传参数、CDN 上传及消息发送的累计耗时；纯文字等于消息发送耗时。 |
| media_prepare_ms | 检查并流式加密媒体快照的耗时。 |
| media_upload_ms | 获取上传参数和向 CDN 上传的耗时，含上传重试。 |
| send_message_ms | 文字及媒体 sendmessage 请求的累计耗时。 |
| first_chunk_ms | 桥收到本次请求后，第一段获得微信接口成功确认的时间。 |
| bridge_ms | 桥处理此次请求到发送完成的时间，含排队、持久化和网络。 |

model_to_submit_ms 很大时检查 Muse 何时调用发送工具；upstream_ms 很大时检查云端网络和代理；queue_ms 很大时检查前面是否有长回复。收消息与发送使用独立连接池；已经提交的回复不等待收件箱轮询或 hook。腾讯协议说明 getupdates 在有消息或超时后返回，35 秒通常是长轮询等待上限，不是每条回复固定增加的耗时。

## 结果查询和重试

`GET /v1/requests/<request_id>` 返回 state 和 result。相同 ID 和内容的并发请求合并；成功后再次提交返回缓存；换内容复用 ID 返回 409。同一收件人保持顺序，不同收件人可并行。

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
- `POST /v1/events/ack`：正文 `{"event_ids":["muse:123"]}`，处理完确认。
- `GET /v1/status`：version、capabilities、登录、接收状态、收件箱数量、发送中请求数；升级后应显示 version=0.3.0、capabilities.send 含 image/video。
- `GET /v1/metrics`：最近 300 请求的状态计数，以及成功请求耗时 p50/p95。失败和 pending 不混入成功耗时。
- `GET /healthz`：进程存活；微信连通性看 status 或 muse-link health。

事件按 event_id 去重，领取有租约。会话、上下文、事件和发送状态在 state_dir 的 SQLite 中。接收批次的事件、上下文和游标原子提交。入站文本和微信语音转写可读；暂不支持的附件通过 media_errors 报告。
