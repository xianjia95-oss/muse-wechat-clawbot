# 连发消息被长工具挡住

> 隐私说明：服务名称、外部主机及调用标识已作示例化处理；.example地址不可作为实际请求目标。实际目标与任务标识只能从部署环境的私密原始交接取得，不得从本文示例恢复或替换。

同步长API占住单个worker会使它无法领取下一条。当前采用 [常驻worker池](NATIVE_PARALLEL.md)：多个原生消费者各自next/reply，一个长任务不占住其他空闲者，独立结果完成即发。全池忙仍排队；--limit 1仅为单次领取量，工具队列只控制本地资源。

按 [外部任务规则](EXTERNAL_API_TASKS.md) 隔离长操作，并限制尝试次数和整段耗时。仅缩短单次请求超时不足以防止反复重试。未知的生成提交先核对，不自动重提。

## 先查每条消息

在新源码目录直接运行，无需 npm 安装、无需停现有 rc.3 服务：

```bash
node scripts/queue-report.mjs --config "$HOME/.config/muse-link/config.json" --since 24h --limit 100
```

只读 SQLite，输出事件/稳定请求编号、接收、最终回复首次提交、accepted、ack 时刻及桥发送耗时，不输出正文、token、账号或工具结果。received_to_submit_ms 包含等待领取、Muse 思考和工具执行，旧数据库没有首次领取时刻，不能再把它拆成精确等待/执行时间。提交后较快 accepted、提交前等待很久，定位 Muse 调度；queue_ms/upstream_ms 很大，再查桥出站排队和微信网络。ack_without_accepted_final 表示没有对应的 accepted 最终回复，可能是告警/空事件的合理 ack，也可能提前确认，必须结合实际任务核对。查询窗口之外、被保留策略清理或未通过白名单的消息不在报告中，不能据空报告断言从未发送。

status 的 worker 计数从本次进程启动起算；SQLite 的 69 条 accepted 等历史指标不会随启动清零。如果当前 claimed_events/reply_requests/last_ingest_at 全零，不能用那 69 条历史发送解释本次启动之后发生了什么。pending=0 也不证明每条消息有回复或手机显示。

## 每个池员的可选后台工具循环

以下工具流程供每个常驻worker处理自己的后台脚本参考，不替代真实多worker池。各slot不共享当前token，工具调度根目录/资源策略共用；主代理按NATIVE_PARALLEL.md创建和维护池，不逐消息spawn。单模型加后台脚本本身不算多Muse任务。

1. 每个池员保持自己的真实 Muse 消息循环。每轮先对所有已领取未完成事件正常续租（每 5 分钟），再刷新其 queued job 的启动截止时间、执行 `tool-job dispatch`，检查工具结果和异步发送回执，然后 `muse next --limit 1 --output-dir "$HOME/.local/state/muse-link-worker/claims"（rc.7，先按MUSE.md准备私密父目录；非空使用返回的handoff_file，空tasks不派发）`。完成或后台提交一条后立即再次领取，不等下一个 90 秒窗口。有后台任务时 next 使用 `--wait 1s`，不要长等待而推迟结果检查；全空闲时才使用较长等待/原生 hook，避免空转。
2. 普通短消息直接回复真实结果，微信使用纯文本、无 Markdown，不发“收到，正在处理”等占位内容。外部 HTTP、生成或测试先持久化原领取文件、稳定工具步骤名、job ID、脚本和结果路径；仅有实质阶段结果或已核实失败/阻塞时，才以稳定 reply-id 发 progress，控制频率，不编造预计耗时，不先 ack。原本需要 checkpoint 的操作，仍先写 started，再启动工具。
3. 用真实 Muse 工具权限准备可信的本地 `.mjs` 脚本，将它交给下面的后台监督器。rc.6 使用 `enqueue --kind io|cpu --start-before ...`，名额满时持久化排队，完成一个后自动补位。返回后继续消息循环，不同步等脚本退出，也不反复等待同一个 shell 工具。HTTP/远端生成等待归 io，本地密集计算归 cpu，混合或不确定时归 cpu；只是分类不会限制脚本真实 CPU。不要将微信正文直接当作脚本/命令执行。凭据放私密配置，不放参数或公开日志；脚本在排队/运行期间不得覆盖改写。
4. 每轮查看 `tool-job list`，结合交接记录处理未回传的终态结果。成功退出不代表业务成功，须核对 HTTP 状态/实际产物；完成步骤后，用原始当前有效 token 提交原事件的最终回复。后来完成的长任务用自然语言指出对应的原请求，不能把它冒充当前短消息的回答。只有 accepted 后才将该 job 通知 settle。

   rc.5 媒体回复加 `--async`，先保存原正文/路径/稳定 request_id，再提交并保存回执。pending 仅表示桥后台正在处理，worker 必须继续处理短消息，逐轮通过 `muse-link request '<id>'` 检查回执、必要时续租，不能同步等上传。accepted 后桥自动 ack，再 settle 工具通知；failed/unknown/rejected 保留交接并按协议核对。只升级 daemon、仍同步等 muse reply 返回，单个模型 worker 依旧会被慢上传挡住。
5. 失败、超时、取消、过期、输出过量或 attention_required 时，核对本地进程和远端实际结果。工具不会自动重跑，started 不能凭猜测改 completed。向 Muse 主聊天或微信安全进度说明失败，继续处理其他消息；不要为了清空队列最终 ack 未完成任务。原 task/token/结果继续私密保留，按正常协议处理续租、恢复和人工核对。相关追问、“取消刚才的任务”及同一资源的修改必须结合上下文串行协调，不能当成互不相关任务盲目并发；独立任务谁完成谁回复，不按领取顺序等待。

## 后台工具监督器

Node.js 24，自带模块，当前只支持 Linux；可从独立新源码目录用于现有 rc.3，无需重启桥。它不调用 Muse 模型、不访问桥、不读 token、不自动 checkpoint/回复/ack。

```bash
# JOB_HELPER 指向实际新源码位置，不是占位目录：
JOB_HELPER='/absolute/muse-link/scripts/tool-job.mjs'
# 两核机器先用此档；计算任务最多 1，网络任务与计算合计最多 4：
node "$JOB_HELPER" configure --max-active 4 --max-io 4 --max-cpu 1 --max-queued 64
node "$JOB_HELPER" status
# START_BEFORE 从本任务已验证的当前 lease_until 减 60 秒得到，使用真实 UTC ISO 时间：
node "$JOB_HELPER" enqueue --id '<稳定job编号>' --kind io \
  --script '/private/workspace/trusted-tool.mjs' --timeout 120s --start-before "$START_BEFORE"
node "$JOB_HELPER" dispatch
node "$JOB_HELPER" list
node "$JOB_HELPER" pending
# 只有原事件正常 renew 成功并保存新的 lease_until 后，才可更新尚在排队的启动截止：
node "$JOB_HELPER" refresh --id '<同一job编号>' --start-before "$NEW_START_BEFORE"
# 需要取消时，只请求终止本地工具；继续查看终态：
node "$JOB_HELPER" cancel --id '<同一job编号>'
# 监督器意外消失：先核对工具进程组已退出及远端结果，再显式关闭本地监督记录：
node "$JOB_HELPER" reconcile --id '<同一job编号>' --reviewed --text - <<'JOB_REVIEW'
这里填写真实核对结果、外部动作是否完成和后续处置；不凭猜测认定成功。
JOB_REVIEW
# 已核对结果及微信 accepted，或明确记录失败处置后：
node "$JOB_HELPER" settle --id '<同一job编号>' --reviewed
```

job ID 使用 event_id 与稳定步骤名的哈希等稳定值，只能包含字母、数字、下划线、短横线，最多 64 字符。相同 ID 即使失败、取消或过期也只返回记录；更改脚本、工具超时或类别重用同 ID 会拒绝。重复 enqueue 不会刷新启动截止，须显式 refresh。不要换 ID 绕过去重，监督器不会证明任意外部操作恰好一次。脚本内容由 Muse 在原有授权范围内准备，不能通过本地 HTTP API 远程传入任意命令。

默认目录 `~/.local/state/muse-link-worker/jobs`，目录 0700、文件 0600；含脚本路径、进程信息和私密 stdout.log/stderr.log。脚本可从 MUSE_LINK_JOB_DIR 取得本次结果目录，但生成图片/视频仍应导出到桥的 media_roots。不要把 base64 图片打印到 stdout；两路日志合计最多 1 MiB，超过会终止工具。状态元数据不输出日志正文；回传前仍需脱敏。

兼容默认总并发/io/cpu 均为 2，排队上限 64；必须执行 configure 才启用 4/4/1。每项并发可设 1..32，排队上限 1..256，所有状态合计最多保留 256 条记录。策略保存在私密 job 根目录的 `.scheduler.json`，独立于桥 config.json；调整不杀已有进程，降低上限后等活动数降到上限以下才补位。旧 `start` 默认归 cpu、满时拒绝，使用 enqueue 才有持久化队列。遇到 job_capacity 或锁竞争时保留原任务、进度和相同 job ID，稍后核对再提交，不能静默丢弃或自动换 ID。启动失败仍须核实 started 步骤。

队列按持久化序号选择最早可运行的任务；cpu 名额满时可跳过该项启动 io，两个上限和总上限同时生效。启动许可须是未来一小时内的 UTC ISO 时间，并早于该事件租约到期，建议减 60 秒；监督器不读取/续租桥 token，也不能验证租约是否被提前撤销。这是防止遗忘续租后排队任务继续启动的期限保护，外部副作用仍须自身幂等键。已运行工具不由这个启动期限终止，仍按工具超时管理；所有未完成事件（排队、运行和异步发送）必须正常续租。续租失败应停止新操作、取消对应 queued job，并核对已经运行的工具；终态 expired 不可复活。未执行的 queued 取消/过期不等于桥 checkpoint 自动 completed，worker 须核对后按 reviewed 流程结清步骤。

监督器完成后自动补位；每轮 dispatch 用于补偿中断或策略变更，hook 的 pending 只读发现可运行/到期的排队项和未结清结果。孤儿活动记录仍占名额，须核对 reconcile；不能自动重跑。定期核对并归档已结清记录；移走后该旧 ID 的监督器去重不再保留，业务侧须保留原事件/checkpoint/结果账本，不能重放。后台目录及策略不属于桥 SQLite 备份，须独立私密备份；不能在有活跃进程时删除锁文件或记录。回滚到 rc.5 前先停止新增调度，排空或明确取消 queued 任务、核对全部活动工具，再切换匹配 worker/helper，旧版不理解 queued 状态。默认工具超时 120 秒，最大 20 分钟；生图按服务约定给足时间，连通性探测另设较短连接和总时限。

rc.6 新 job 在隐藏 `.new-*` 私密目录中写完并同步元数据后才原子发布；未发布的暂存目录不会执行脚本，也不占活动名额，不自动删除。旧版若已留下可见 job 目录但缺失/损坏 job.json，仍会停止调度检查，防止忽略未知执行状态而超发或重跑。先保留目录、锁和交接记录，核实进程及外部结果后人工处理；升级不会自动修复这些旧记录。终态工具的原脚本被清理后，同 ID 查询仍返回原记录；更改路径、超时或类别仍拒绝。

时限、cancel 和 SIGTERM 会终止监督器所管理的本地 Linux 进程组；脚本不能自行创建脱离该进程组的守护进程。远端 HTTP 操作可能已经发生，终止不代表撤回。监督器遭 SIGKILL 时子进程可能仍在运行；list/pending 使用 Linux 启动身份识别可观察到的监督器消失，给出 attention_required，PID 存活也不是工作正确的证明。rc.5 的 reconcile 要求私密 stdin 核对说明（最多 8192 字节）和 --reviewed；在启动/监督锁内重读状态，监督器或原工具进程组仍存活时拒绝，不发送信号。关闭后为 interrupted，释放占用的活动名额，但不表示业务成功；原 ID 和核对说明保留，不重跑、不 checkpoint、不回复、不 ack，通知仍须后续 settle。缺少进程身份的旧记录保守拒绝自动结案。私密核对说明不在 list/start 缓存输出中展示。工具执行前先确认 durable 元数据已记录本进程与启动代次，避免 spawn 与写盘之间被杀后产生未登记副作用。长任务按原协议每 5 分钟续租；换班前核实 worker、工具进程和交接记录，不读数据库 token 强行接管。

## hook 要同时发现新消息和工具结果

rc.4 的 deploy/wechat-hook.sh 在 inbox 非空时立即 wake，空队列下也检查后台工具的完成/需核对结果。检测结果没有全局 90 秒去重；原有一小时节流只用于健康告警。Muse 平台另加的 90 秒去重须核实并调整：不能把新消息和新工具结果一并屏蔽；已有 worker 时让原循环处理，不重复拉起处理同一交接文件的 worker。

若新源码暂不安装到 current，可让原生 hook 使用真实绝对路径执行：

```bash
MUSE_LINK_JOB_HELPER='/absolute/new-source/scripts/tool-job.mjs' \
  sh '/absolute/new-source/deploy/wechat-hook.sh'
```

建议检测间隔 5 秒，以真实平台支持为准。先 dry_run，确认无任务领取副作用，再 enable；记录实际生效的去重规则和间隔。不能把本仓库脚本替换当作平台 hook 注册已经成功。仅升级 daemon 不会把原来阻塞等待 curl 的 worker 自动改成以上循环。

## 连发验收

先用一个无网络副作用的测试脚本在后台等待 110 秒并输出一个短结果。在它仍 running 时，从微信连续发 5 条带不同编号的短消息；逐条记录 received、最终提交、accepted 和手机收取。要求 5 条均有对应回复，且不用等 110 秒任务结束；工具结束后原任务再准确回传。这里不承诺固定秒数，Muse 调度与手机显示必须实测。再验证单个工具超时、稳定 ID 再次 start 不重复执行、换班恢复和工具完成后 inbox=0 的 hook 唤醒。准备好证据后才使用真实生图 API。

关于网络原因：源站 Authorization 头通常在 TLS 建立后才发送，单凭超时不能认定代理按该头阻塞 TLS。应以不包含凭据的 DNS/connect/TLS/首字节耗时核对，不能回传带 Authorization、Proxy-Authorization 的 curl verbose/trace 日志。网络诊断应在后台工具里做，不能再次占住消息循环。
