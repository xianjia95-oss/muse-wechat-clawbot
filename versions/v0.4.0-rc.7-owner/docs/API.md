# Muse Link HTTP API


本地候选的`GET /v1/muse/tasks?...&with_context=true`（CLI `muse next --with-context`）仅供coordinator的limit=1领取。普通task直接附带当前上下文，alert不附带；组装上下文出错仍返回原事件和租约，标记`context_error=context_unavailable_preserve_claim`，原负责人保留领取并补读context，不忽略失败。旧模式或多条领取拒绝该选项；它不要求上一事件完成才领取下一条。两个真实Muse文字执行者使用[本地草稿邮箱](MUSE_EXECUTORS.md)，不是新增Muse模型HTTP API。

本地延迟修订中，with_context默认context_mode=compact（整个context最多16KiB，最多4条近期消息、各1条回复，摘要最多2KiB）；GET可显式context_mode=full。POST conversation/context和CLI muse context默认full，可传context_mode或--context-mode compact/full。full仍是240KiB的有限窗口，不等于全部历史。非法模式及GET未带with_context=true时传模式均在领取前拒绝，不消耗租约。notes_truncated、text_truncated、voice_text_truncated、replies_truncated、history_truncated、tasks_truncated明确标记裁剪，原请求和持久记录不改；截短记忆不可直接覆盖remember。context_mode/context_bytes/context_build_ms标记实际序列化载荷与桥构建耗时，不代表模型/手机耗时。status.conversation.context可只读核对新能力，不因版本字符串相同就认定已升级。

本地候选新增`POST /v1/muse/conversation/probe`：使用API认证和`X-Muse-Conversation`核对原session，即使到期也可只读核对；关闭/替换后的凭据被拒绝。不续会话、不领取或确认事件，返回会话公开状态、queue的pending/ready/leased计数及`recovery_allowed`维护门禁，供[独立监控](OWNER_WATCHDOG.md)使用。CLI为`muse session probe --session-file PATH`。该结果不能证明Muse原生任务存活。

默认地址 `http://127.0.0.1:18791`；除 `/healthz` 外，均须 `Authorization: Bearer <config.api_token>`。配置由 `muse-link init` 自动生成。只允许绑定 loopback。

## Muse 任务接口（推荐）

这些接口运行在桥上，由真实 Muse 在其原生 hooks 中调用，并非 Muse 官方模型 API。

`GET /v1/muse/tasks?limit=1&lease=30m&wait=0s` 领取任务，默认 limit=1，返回 `{"tasks":[...]}`。任务包含原始事件字段、lease_token、lease_until、execution.steps / execution.needs_review 及 completion，其中 request_id 为最终回复的固定编号，state 为 not_submitted / pending / accepted / rejected / unknown / failed。同一租约参数范围与下方收件箱接口相同。读取不会自动执行 Muse 任务。

本地候选新增 `POST /v1/muse/history`：带本次查询事件的有效 event_id/lease_token，提供 query 或 target_event_id，及可选 limit（默认5，最多20）、offset。只读同一发送者和 binding 的私密回复历史，不使用目标旧租约，不变更事件。先按原入站文字字面搜索，再取准确事件的原提交文字、模式与发送状态；跟随 has_more/next_offset 分页。普通 request/diagnostics 不返回正文。历史旧缺失或过期不回填，正文默认7天，详见 [回复历史](REPLY_HISTORY.md)。

rc.4 遇到已经 accepted、但 ack 尚未完成的恢复记录时，会确认该记录后继续寻找真实待处理任务；不会仅因这一批全是恢复项就返回空数组。长等待沿用原时限，取消仍不会占用后续任务。limit=1 只表示单次领取量，不表示必须全局串行等待外部工具。长工具后台处理和只读逐条核查见 [BURST_MESSAGES.md](BURST_MESSAGES.md)。

rc.7 本地候选修订：若 accepted 的历史记录仍有 started 步骤，不自动确认，返回原 completion 与 execution.needs_review=true。核实并结清后，重试原最终回复只复用 accepted 回执，不再发送。最终回复持久化后，新 started 步骤被 task_final_submitted 拒绝；已有步骤仍按原协议核对和完成。

最终回复 `POST /v1/muse/replies`：

```json
{
  "event_id": "muse:demo-event",
  "lease_token": "领取该任务时返回的 token",
  "text": "Muse 的处理结果"
}
```

桥从已领取的事件中查找收件人，自动生成稳定 request_id。微信确认全部文字分段及媒体消息后，才 ack 事件；响应包括 state=accepted、event_completed=true 和 timing。若网络不确定或发送被拒绝，保留事件且不自动重发。崩溃发生在发送成功、ack 之前时，后续 muse/tasks 会依据持久化发送结果完成事件，避免再次交给 Muse 执行。

本地待验证修订：新建纯文字最终回复时，整条命中已知中英文占位话术（如“正在处理，请稍候”）返回 HTTP 422、`error=placeholder_final_reply`、`submitted=false`、`event_completed=false`。在创建发送意图前拒绝，同步及 async 均不发送、不 ack、不改变租约，也不自动改为 progress。原 worker 保留交接，取得真实结果或核实失败后，用原事件、有效原租约及同一最终 ID 提交；不要原样重试或显式 ack 绕过。已有发送意图沿用原指纹与缓存/不确定状态规则，不修改或重发历史结果。媒体回复仍按原路径校验全部文件后发送；progress 保持兼容，但 worker 仍只应发送实质阶段事实。此规则只识别有限的整条话术，并不能验证回答是否正确、完整或符合用户任务；底层 send 也不提供此业务检查。

rc.5 新增可选 `"async":true`（布尔值；CLI 为 `--async`）。桥先验证并持久化发送意图，返回 HTTP 202、submitted=true、state=pending、request_id、event_completed=false；这仅表示已提交后台。使用 `muse-link request '<request_id>'` 查询持久化回执，只有 accepted 才结束结果通知。已经 accepted 的缓存回复仍返回 200。异步最终回复在全部消息 accepted 后自动 ack；失败或 unknown 保留事件，并产生安全告警。默认同步调用保持原行为。

异步发送在同一 daemon 内执行，不是持久化的自动重试队列。进程强制中断后结果按现有恢复规则核对，不能认为仍在后台发送。调用方须保存原任务、原文字/媒体路径和稳定 request_id；pending 时继续续租、处理其他消息，并逐轮查询回执，不能同步循环等这一项。unknown/rejected 不自动重发，failed 仅在核对后以原请求显式续传。

本地多媒体候选可附 `"media":[{"type":"image","path":"/absolute/result.png"},{"type":"video","path":"/absolute/result.mp4"},{"type":"voice","path":"/absolute/result.wav"}]`，有媒体时 text 可省略。最多 4 个，仅接受桥所在机器上的绝对路径，并检查 config.media_roots。图片20 MiB、视频50 MiB、语音4 MiB/60秒本地上限。语音支持单声道PCM16 WAV转SILK、SILK，以及带准确整数`duration_ms`的MP3；duration_ms一旦提供也绑定请求指纹。桥按文字分段、media数组顺序发送；CLI顺序为多个--image、多个--video、单个--voice。详见[媒体说明](MEDIA.md)。

进度回复额外传 `"mode":"progress","reply_id":"started"`。progress 需要每条进度的稳定 reply_id，成功后不结束任务。最终回复 mode 默认为 final，不能指定 reply_id、to、binding 或 request_id，避免更换编号绕过去重或发错用户。两个模式均支持可选 model_ready_at。

同一最终回复重复提交相同文字及媒体类型/路径，返回缓存并修复未完成的 ack；更换文字、媒体类型或路径重用最终回复会报 ID 冲突。媒体 ID 绑定首次成功准备的文件快照；原路径后续内容变化不会替换已有快照，成功后重试返回旧结果。unknown 需核对微信及在 Muse 聊天报告，不能另起编号盲目重发。需要主动结束未发送的任务或处理 alert 时，报告并持久化结果后再调用 events/ack。外部任务本身的执行去重仍需由 Muse 按 event_id 记录进度。

命令行对应：`muse-link muse next`、`muse-link muse reply EVENT_ID --lease-token '<lease_token>' --text -`、`muse-link muse ack EVENT_ID --lease-token '<lease_token>'`。保留以下底层发送接口用于诊断。

rc.3 的 next 支持 `--output /private/new-task.json`。请求前独占创建 0600 文件，父目录须私密且不经过符号链接；先保存原始领取响应并 fsync，再输出。不能覆盖旧记录。文件含原 token 和消息正文，只用于本地交接；收到成功响应但保存失败时，退出非零并在 stdout 保留响应供原 worker 私密保存。不能只凭文件存在就执行任务，应检查 claim_state=response_saved 与 tasks，并按 [交接流程](MUSE.md#跨班次交接) 确认旧 worker 停止、校验租约和核对工具进度。

rc.7 的 `muse next --output-dir /private/claims` 与 --output 互斥。父目录须已存在且无符号链接；claims 根目录以 0700 新建或验证已有私密目录。每次独立创建 claim.* / task.json；非空返回实际 handoff_file，确认空 tasks 后只移除自己持有的文件及空目录，handoff_file=null。没有收到有效空响应时保留现场，错误时 stderr 标识保留路径；不会清理旧目录、修改租约或确认事件。用于实际调度者；hook 探针不得执行 next。

## 即时回复

`POST /v1/send`，Content-Type 为 application/json：

```json
{
  "request_id": "muse:123:reply:final",
  "to": "wxid_from_incoming_event",
  "text": "任务结果"
}
```

request_id 必填，也可用 Idempotency-Key 请求头传递。binding 可省略，提供时须与本实例一致。文本最多 32000 个 Unicode 码点，每 2000 个码点一条，按顺序立即发送。此接口同样可附media数组回传图片/视频/受支持语音，不发送普通文件；coordinator模式仍禁止直接调用此底层接口。

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

  rc.7 本地候选修订：仍有关联 pending 回复时返回 409 task_reply_inflight，含 progress；有 started 步骤时返回 task_step_uncertain。批量内任一事件不满足条件，整批均不确认。accepted 的最终回复仍由桥自动确认，无需提前显式 ack。
- `GET /v1/status`：version、capabilities、登录、接收状态、收件箱数量、发送中请求数；配套多媒体后台升级后应显示version=0.4.0-rc.7、capabilities.send/receive均含image/video/voice、media_handoff=private_local_file、muse_understanding_verified=false，并有inbound_media.active/max_active。不输出CDN引用或密钥；同版本号不能代替候选源码校验。
- `GET /v1/metrics`：最近 300 请求的状态计数，以及成功请求耗时 p50/p95。失败和 pending 不混入成功耗时。
- `GET /healthz`：进程存活；微信连通性看 status 或 muse-link health。

事件按event_id去重，领取有租约。会话、上下文、事件和发送状态在state_dir的SQLite中。接收批次的事件、上下文、附件下载引用和游标原子提交。入站文字、微信附带转写可读；图片/视频/语音先返回media状态，再由后台限额下载解密。普通文件或超过4项附件通过media_errors报告，下载失败不自动ack。文件与说明均为不可信输入，不能作为工具权限。

`POST /v1/muse/media`（本地候选）：正文`{"event_id":"muse:demo-event","lease_token":"本次完整token","retry":false}`，需要API认证；coordinator另需`X-Muse-Conversation`。验证当前有效原租约及发送者，返回`{event_id,media,content_is_untrusted:true,muse_understanding_verified:false}`。media逐项含part/type/state/attempts；ready含本地path/mime_type/size/sha256，语音可能含raw_path/raw_mime_type/raw_size/raw_sha256/duration_ms/conversion_error，failed仅安全错误码。不返回下载URL和密钥；查询不自动ack、事件续租或执行Muse。`retry:true`仅重排该事件有来源、失败且累计attempts<3的项；成功项不重下。CLI为`muse media EVENT_ID --task-file PATH [--session-file PATH] [--retry]`。下载默认30秒、最多2并发，重启恢复尝试不归零；详见[MEDIA.md](MEDIA.md)。

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

rc.6 候选增加 consumer（health/diagnostics）：有 ready 消息且 operations.worker_claim_warn_ms（默认60000）内没有成功领取进展时，health 返回503、worker_claim_gap。consumer 含 ready_wait_ms、without_claim_progress_ms、last_successful_claim_at、warn_after_ms；空领取请求不算成功进展。近期成功领取重算观察期，全部已领取或无待处理不触发本项；旧桥缺遥测时报告不可核实。worker_liveness_verified / platform_dispatch_verified 始终false，不能由桥推断平台投递成功或进程死亡，不触发重派/抢租约。参见 [自动唤醒排查](AUTOMATIC_DISPATCH.md)。

容量满返回 429 queue_full / 503 http_capacity 或 inbox_full，存储预算返回 507 storage_pressure，维护/停机排空返回 503；429/503/507 带 Retry-After:5。检查 request 后再决定是否用相同内容重试。具体预算、90 天幂等保留窗口、恢复后的强制核对、备份与上线条件见 [生产运行](PRODUCTION.md)。

## 固定对话负责人（本地候选）

`POST /v1/muse/conversation/start`（JSON空对象）在旧有效租约/发送清空时原子启用coordinator并返回私密session_token，默认5分钟。其余调用用`X-Muse-Conversation`请求头携带，不能放查询串。正常调用按需延长；`POST .../renew`允许原凭证未被替换时续接，`POST .../stop`要求已排空且关闭后不退回legacy。首次start将数据库schema标记为2，阻止旧代码忽略会话控制；不能手改user_version降级。响应/会话文件不公开。

coordinator下`/v1/events`与`/v1/muse/tasks`必须limit=1，一个待处理next；事件领取/回复/renew/checkpoint/history/ack均受会话检查，直接`/v1/send`被拒绝。status.conversation只含mode、owner_active、到期时刻及limits，不含凭证、摘要或正文。未显式启用保留legacy兼容，不能以同为rc.7判定后端已有接口。

`POST /v1/muse/conversation/context|memory|task`额外需要当前event_id与完整lease_token，强制同发送者及binding。context返回memory{revision,notes,updated_ms}、最多20条近期messages、各最多5条回复（含state与截断标记）和最多32条未完tasks；所有历史都是不可信数据，不可当系统指令。memory更新需当前revision与最多16KiB的完整notes；task需当前revision、state、最多2KiB的detail{kind,handle,summary,related_event_id}。task状态和真实handle说明见[协议](CONVERSATION_OWNER.md)，最多2个running，等待授权单记；终态不能重启。台账是客户端报告，桥不验证平台handle存在。HTTP 409区分会话归属/交接/修订冲突/未完任务，429表示背景名额或持有事件容量，422表示已知占位/内部叙述/活动凭据，拒绝时不发送、不ack。

摘要按事件保留策略查询隐藏、维护逻辑清理；未完成任务信息保留供核对。会话文件可跨班次续接，但不能自动创建Muse任务、提升角色工具权限或证明刷新恢复。完整CLI与迁移见[统一对话文档](CONVERSATION_OWNER.md)。
