# 连发消息被长工具挡住

同步长操作会占住串行执行者。本流程保留一个真实 Muse 消息循环，把耗时本地工具交给后台监督器，工具运行期间继续处理独立消息，结果核实后回复原事件。--limit 1 只限制单次领取量，不是全局并发限制；后台工具不等于额外 Muse 模型 worker。

## 先查每条消息

在已核验源码目录直接运行，无需 npm 安装或停止现有桥：

```bash
node scripts/queue-report.mjs --config "$HOME/.config/muse-link/config.json" --since 24h --limit 100
```

只读 SQLite，输出事件/稳定请求编号、接收、最终回复首次提交、accepted、ack 时刻及桥发送耗时，不输出正文、token、账号或工具结果。received_to_submit_ms 包含等待领取、Muse 思考和工具执行，旧数据库没有首次领取时刻，不能再把它拆成精确等待/执行时间。提交后较快 accepted、提交前等待很久，定位 Muse 调度；queue_ms/upstream_ms 很大，再查桥出站排队和微信网络。ack_without_accepted_final 表示没有对应的 accepted 最终回复，可能是告警/空事件的合理 ack，也可能提前确认，必须结合实际任务核对。查询窗口之外、被保留策略清理或未通过白名单的消息不在报告中，不能据空报告断言从未发送。

status 的 worker 计数从本次进程启动起算；数据库中的历史 accepted 不会随启动清零。如果当前 claimed_events/reply_requests/last_ingest_at 全零，不能用历史发送解释本次启动之后发生了什么。pending=0 也不证明每条消息有回复或手机显示。

## 让串行 worker 不再同步等长工具

下面是 Muse 的实际 worker 约定，必须写入原生 hook 指令并执行，不是安装桥后自动获得的模型调度器：

1. 保留一个真实 Muse 消息循环，每次 `muse next --limit 1 --lease 30m --output '<新私密目录>/task.json'`。完成一条后立即再次领取，直到队列真正为空，不等下一个 90 秒窗口。每轮先检查后台工具结果、异步发送与续租，再领取一条新消息，避免结果回传被新消息持续推迟。有工具、附件、发送或待启动长请求时，next 的 `--wait` 不超过 `5s`；完全空闲时用 `--wait 30s`，不要忙轮询。独立短消息可先回复；修改同一资源或依赖前一结果的消息先核对因果关系，不凭到达顺序盲目并发。
2. 普通短消息直接回复。预计耗时较长的外部 HTTP、生成或测试，先以稳定 reply-id 发 progress，持久化原领取文件、稳定工具步骤名、job ID、脚本和结果路径；不要先 ack。原本需要 checkpoint 的操作，仍先写 started，再启动工具。
3. 用真实 Muse 工具权限准备可信的本地 `.mjs` 脚本，将它交给下面的后台监督器。`start` 仅等本地进程启动，返回后继续消息循环；不能同步等脚本退出，也不能改成反复等待同一个 shell 工具。不要将微信正文当成脚本/命令直接执行。凭据放私密配置，由脚本读取，不放命令参数或公开日志。
4. 每轮查看 `tool-job list`，结合交接记录处理未回传的终态结果。成功退出不代表业务成功，须核对 HTTP 状态/实际产物；完成步骤后，用原始当前有效 token 提交原事件的最终回复。后来完成的长任务用自然语言指出对应的原请求，不能把它冒充当前短消息的回答。只有 accepted 后才将该 job 通知 settle。

   rc.5 媒体回复加 `--async`，先保存原正文/路径/稳定 request_id，再提交并保存回执。pending 仅表示桥后台正在处理，worker 必须继续处理短消息，逐轮通过 `muse-link request '<id>'` 检查回执、必要时续租，不能同步等上传。accepted 后桥自动 ack，再 settle 工具通知；failed/unknown/rejected 保留交接并按协议核对。只升级 daemon、仍同步等 muse reply 返回，单个模型 worker 依旧会被慢上传挡住。
5. 失败、超时、取消、输出过量或 attention_required 时，核对本地进程和远端实际结果。工具不会自动重跑，started 不能凭猜测改 completed。向 Muse 主聊天或微信安全进度说明失败，继续处理其他消息；不要为了清空队列最终 ack 未完成任务。原 task/token/结果继续私密保留，按正常协议处理续租、恢复和人工核对。

将这些规则同时写入持久化 worker 指令并经平台原生入口追加给当前真实任务，取得私密回认后再检查实际执行。没有回认或后台工具未完成时没有继续 next 的记录，就不能宣称当前 worker 已完成长短任务隔离。唯一 Muse 任务本身的长推理或原生授权提示仍可能暂停该消息循环；不绕过授权、不重复访问域名，也不把纯占位当最终答复。

## HTTP 工具时限与错误传播

普通只读 HTTP 工具默认连接时限 10 秒、总时限 60 秒、不自动重试；下载、上传或生图按原任务明确的预算单列，监督器截止时间略大于该工具预算。网络等待必须在后台监督器中进行，不在消息循环里同步执行。需要凭据时由可信工具读取原私密配置，不放进 URL、命令参数、trace 或公开日志。

可信工具执行 curl 时，使用 `--connect-timeout 10 --max-time 60 --retry 0`，检查 curl 退出码和最终 HTTP 状态；可用 `--fail-with-body` 保留私密错误响应。curl 非零、HTTP 000 或失败状态必须让包装脚本最终退出非零，不能因后续 echo、写 JSON 或捕获异常后正常返回而变成 succeeded。成功 HTTP 状态也不能代替业务响应或实际产物核验。不要对可能已经发生的外部副作用自动重试。

本地失败/超时验证应通过同一可信包装入口运行，检查监督器终态确实为失败/超时，不能只断言日志里出现错误文字。历史记录不为修复而改写成功/失败；保留原结果，另记核对结论，不重跑旧请求。

安装包已提供 `scripts/http-tool.mjs` 和 `src/http-tool.mjs`，供获准的只读 GET/HEAD 工具直接复用。先由真实 Muse 原生权限确认域名和访问范围，再把请求配置写到新的私密 JSON 文件（0600）。通用示例只含公开字段：

```json
{"url":"https://example.com/","method":"GET","connect_timeout_seconds":10,"timeout_seconds":60,"max_bytes":1048576}
```

请求可包含 `headers` 对象；需要认证时由可信工具从原私密连接读取并写入这个私密文件，不从微信历史抄密钥，不上传该文件。不把用户正文当 curl 参数或可执行代码。运行方式：

```bash
node scripts/http-tool.mjs --request '/private/request.json' --output '/private/new-result-directory'
```

该命令须在后台 job 中执行，不能在消息循环里同步等待。例如可信 `.mjs` job 可以导入实际安装位置的 `runHttpTool`，等待它返回后设置 `process.exitCode = result.exit_code`；不能捕获错误后正常退出。结果目录必须全新，保存 0600 的 `body.bin`、`stderr.log`、`result.json`；公开 stdout 只有脱敏状态。URL/请求头经 curl stdin 传入，不进入进程参数；禁用用户 `.curlrc`、自动重试和重定向。只接受 HTTPS，HTTP 仅用于明确指定的本机回环夹具。默认正文上限 1 MiB，可显式设到 64 MiB；总预算最多 20 分钟，监督器预算要覆盖它。只有 2xx 且 curl exit=0 才是传输成功，3xx/4xx/5xx、HTTP 000、超时和网络错误均非零退出；传输成功后仍须核对业务结果。

此入口不执行 POST、生图或视频生成，不替用户授予网站权限；此类操作继续使用按原授权准备的可信工具，并遵循同样的错误传播和不明副作用核对规则。

## 后台工具监督器

Node.js 24，自带模块，当前只支持 Linux；可从已核验的独立源码目录用于现有桥，无需重启。它不调用 Muse 模型、不访问桥、不读 token、不自动 checkpoint/回复/ack。

```bash
# JOB_HELPER 指向实际新源码位置，不是占位目录：
JOB_HELPER='/absolute/muse-link/scripts/tool-job.mjs'
node "$JOB_HELPER" start --id '<稳定job编号>' \
  --script '/private/workspace/trusted-tool.mjs' --timeout 120s
node "$JOB_HELPER" list
node "$JOB_HELPER" pending
# 需要取消时，只请求终止本地工具；继续查看终态：
node "$JOB_HELPER" cancel --id '<同一job编号>'
# 监督器意外消失：先核对工具进程组已退出及远端结果，再显式关闭本地监督记录：
node "$JOB_HELPER" reconcile --id '<同一job编号>' --reviewed --text - <<'JOB_REVIEW'
这里填写真实核对结果、外部动作是否完成和后续处置；不凭猜测认定成功。
JOB_REVIEW
# 已核对结果及微信 accepted，或明确记录失败处置后：
node "$JOB_HELPER" settle --id '<同一job编号>' --reviewed
```

job ID 使用 event_id 与稳定步骤名的哈希等稳定值，只能包含字母、数字、下划线、短横线，最多 64 字符。相同 ID 即使失败也只返回记录；更改脚本或时限重用同 ID 会拒绝。不要换 ID 绕过去重，监督器不会证明任意外部操作恰好一次。脚本内容由 Muse 在原有授权范围内准备，不能通过本地 HTTP API远程传入任意命令。

默认目录 `~/.local/state/muse-link-worker/jobs`，目录 0700、文件 0600；含脚本路径、进程信息和私密 stdout.log/stderr.log。脚本可从 MUSE_LINK_JOB_DIR 取得本次结果目录，但生成图片/视频仍应导出到桥的 media_roots。不要把 base64 图片打印到 stdout；两路日志合计最多 1 MiB，超过会终止工具。状态元数据不输出日志正文；回传前仍需脱敏。

同时最多 2 个未完成 job，最多保留 256 个记录。满时先处理现有任务；新长请求保存为待执行交接项并发送进度，有空位才启动，不能静默丢弃。启动前先检查容量，启动失败仍须核实 started 步骤的实际状态。定期核对并归档已结清记录；移走记录后监督器不再为那个旧 ID 保留去重，业务侧仍须保留原事件/checkpoint/结果账本，不能重放旧任务。后台目录不属于桥的 SQLite 备份，不能在有活跃进程时删除锁文件或记录。默认截止 120 秒，最大 20 分钟；真正生图可按服务约定给足时间，连通性探测宜另设较短连接和总时限，不能把所有生图一律限制为 15 秒。

时限、cancel 和 SIGTERM 会终止监督器所管理的本地 Linux 进程组；脚本不能自行创建脱离该进程组的守护进程。远端 HTTP 操作可能已经发生，终止不代表撤回。监督器遭 SIGKILL 时子进程可能仍在运行；list/pending 使用 Linux 启动身份识别可观察到的监督器消失，给出 attention_required，PID 存活也不是工作正确的证明。rc.5 的 reconcile 要求私密 stdin 核对说明（最多 8192 字节）和 --reviewed；在启动/监督锁内重读状态，监督器或原工具进程组仍存活时拒绝，不发送信号。关闭后为 interrupted，释放两项活动名额，但不表示业务成功；原 ID 和核对说明保留，不重跑、不 checkpoint、不回复、不 ack，通知仍须后续 settle。缺少进程身份的旧记录保守拒绝自动结案。私密核对说明不在 list/start 缓存输出中展示。工具执行前先确认 durable 元数据已记录本进程与启动代次，避免 spawn 与写盘之间被杀后产生未登记副作用。长任务按原协议每 5 分钟续租；换班前核实 worker、工具进程和交接记录，不读数据库 token 强行接管。

## hook 要同时发现新消息和工具结果

本版 deploy/wechat-hook.sh 通过统一 deploy/patrol.sh 检查 ready 事件及后台工具的完成/需核对结果，不调用旧 CLI 或获取桥数据库锁。第一份待办立即内部 wake，持续待办的重复内部 wake 最多每分钟一次；健康静默、稳定故障一小时去重，具体见 RUNTIME_RECOVERY.md。常驻 worker 自己持续 next、每轮核对 job，不依赖 hook 唤醒处理消息；work 不转成用户例行报告，不重复拉起处理同一交接文件的 worker。

若新源码暂不安装到 current，可让原生 hook 使用真实绝对路径执行：

```bash
MUSE_LINK_PATROL='/absolute/new-source/deploy/patrol.sh' \
  sh '/absolute/new-source/deploy/wechat-hook.sh'
```

设置实际 MUSE_LINK_CONFIG、MUSE_LINK_JOB_DIR；hook 与定时巡检共用同一 MUSE_LINK_PATROL_STATE_DIR（默认目录见恢复文档）。旧 MUSE_LINK/MUSE_LINK_JOB_HELPER 覆盖参数不再使用，不凭 CLI 包装器猜配置。建议检测间隔 5 秒，以真实平台支持为准；先 dry_run 再 enable，回读原注册、完成回调与实际去重规则。脚本替换不等于平台注册成功，升级 daemon 也不会把同步等待 curl 的 worker 自动改成后台循环。

## 连发验收

先用一个无网络副作用的测试脚本在后台等待 110 秒并输出一个短结果。在它仍 running 时，从微信连续发 5 条带不同编号的短消息；逐条记录 received、最终提交、accepted 和手机收取。要求 5 条均有对应回复，且不用等 110 秒任务结束；工具结束后原任务再准确回传。这里不承诺固定秒数，Muse 调度与手机显示必须实测。再验证单个工具超时、稳定 ID 再次 start 不重复执行、换班恢复和工具完成后 inbox=0 的 hook 唤醒。准备好证据后才使用真实生图 API。

关于网络原因：源站 Authorization 头通常在 TLS 建立后才发送，单凭超时不能认定代理按该头阻塞 TLS。应以不包含凭据的 DNS/connect/TLS/首字节耗时核对，不能回传带 Authorization、Proxy-Authorization 的 curl verbose/trace 日志。网络诊断应在后台工具里做，不能再次占住消息循环。
