# 在 Meta Muse 云端部署

独立程序 Muse Link v0.4.0-rc.7，将 Meta Muse 对接微信 ClawBot。需要 Muse 自己的 Linux、Node.js 24+ / npm、运行中的 systemd、服务安装权限和 Muse hooks。文字与图片/视频回传的实际账号收取仍待验证。Muse 使用自身的任务能力处理消息，本项目不调用或替换其模型。

先请用户在微信“我 → 设置 → 插件”确认并启用 ClawBot。部署使用 Muse 自己的云端，不要求额外公网 IP；云实例必须能持续运行桥、访问腾讯 HTTPS 接口并注册平台原生 hooks。

本项目直接使用微信 iLink 协议。[接入与协议说明](REFERENCE.md) 记录了长轮询、验证码、媒体能力和验收边界，实际账号仍须按部署流程验证。

必须交付桥与真实常驻 Muse worker 池：桥接收并持久化微信消息，多个原生 worker 各自直接 next/reply 并持续循环。主代理负责启动、查询、补位和换班；hook 只读检测、告警及恢复提示，不是每条消息必经入口。平台注册必须使用当前环境真实工具并核实结果。

## 安装

解压后，以 Muse HOME 属主身份执行，不要 sudo 整个脚本：

```bash
cd muse-link
bash deploy/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

安装路径 `~/.local/share/muse-link`，命令 `~/.local/bin/muse-link`，配置和私密代理 env 在 `~/.config/muse-link`，状态在 `~/.local/state/muse-link`。安装器生成 token，保留已有配置，只安装服务，不自动启动。

当前 shell 导出的 HTTP/HTTPS 代理会保存到服务 env，ALL_PROXY 可作后备；只支持 HTTP/HTTPS，不支持 SOCKS。服务不会自动继承交互 shell 的代理。修改 env 后重启服务。HOME 和云实例运行期须持久化，实例停止时桥也停止。

Windows 可从源代码执行 npm ci、node src/cli.mjs init、node src/cli.mjs login、npm start；systemd 安装器用于 Muse 云端。

## 从 Muse Link v0.2.x / v0.3.x 升级

完成已领取的任务或持久化交接进度，暂停现有微信 hook。停止 muse-link 服务后，从 v0.4.0-rc.7 新解压目录运行安装器，保留原配置、登录和 SQLite 状态，不删除数据库：

```bash
systemctl stop muse-link
bash deploy/install.sh
```

普通用户为 systemctl 加 sudo -n。安装器会先离线备份、将候选版装入 releases，再切换 current，保留上一版供回滚。同步按本页更新 worker 的 lease_token、renew 和 checkpoint；旧配置也默认要求 token。详见 [生产运维](PRODUCTION.md)。安装器保留配置，已有配置缺少 media_roots 时默认 ~/workspace；按 [媒体说明](MEDIA.md) 把生成工具实际输出目录合并到配置，再按下方步骤启动服务。更新旧 hook 中的纯文字限制，重新 dry_run 并启用。muse-link status 必须显示 version=0.4.0-rc.7、capabilities.send 含 image/video，不能只根据新 CLI 的版本判断后台升级成功。已有会话健康时无需重新扫码。可直接使用 [升级指令](给Muse升级的指令.txt)。

## 扫码

没有可用会话时执行。重新扫码前先暂停 hook、停止 muse-link 服务；登录和服务使用同一个状态锁，运行中登录会返回 state_locked。扫码成功后再按下一节启动服务：

```bash
mkdir -p "$HOME/workspace"
setsid nohup "$HOME/.local/bin/muse-link" login \
  --qr-dir "$HOME/workspace" --timeout 10m \
  > "$HOME/muse-link-login.log" 2>&1 < /dev/null &
```

日志每出现一行 event=qr，确认进程仍在且图片存在，立即把 file 指定的原始图片展示在 Muse 聊天，写明 qr_number、id_prefix 与 expires_at，提醒用户扫描并手机确认。expires_at 是客户端单码等待上限（最多 5 分钟，expiry_source=client_refresh_limit），不保证服务端始终有效到该时间；微信返回 expired 时立即换码。每个路径唯一，不要复制到固定路径或重发旧码。用户需在另一屏幕看图。新 qr 记录代表换码，logged_in=true 才成功。进程结束会删除图片；10 分钟超时后等用户准备好再试。

### 手机要求配对验证码时

日志 event=verification_required 表示手机微信显示了一组配对数字。请用户把这组数字发给 Muse，保留前导零；retry=true 表示上次输入未被接受。用同一条日志给出的完整 code_file 路径提交：

```bash
muse-link login verify --code-file '<日志中的 code_file>' --text - <<'WECHAT_CODE'
手机显示的数字
WECHAT_CODE
```

源代码运行时把命令改为 `node src/cli.mjs login verify ...`。正文仅能为数字，上述文字占位符必须替换。验证码从标准输入传入，不放进命令参数；命令只输出 submitted=true，不代表已登录。等待原登录日志 logged_in=true；若再次 verification_required，使用新的 code_file 并请用户核对手机。临时文件在读取、取消或超时后删除，验证码不写入会话数据库。verification_blocked 表示微信阻止继续尝试，停止并稍后重新扫码；already_bound 不代表拿到了新凭证，应检查现有 Muse Link 服务的 status/health。

## 启动与检查

root 直接执行，其他用户为 systemctl 加 sudo -n：

```bash
systemctl enable muse-link
systemctl restart muse-link
systemctl is-active muse-link
muse-link status
muse-link health
```

首次微信长轮询可能等待约 35 秒，health 需至少一轮成功。应为 logged_in=true、poll.state 为 waiting/ok、last_ok_at 非空且无 error。alive 不能证明微信可用。每次新扫码或改配置/env 后重启。日志用 `journalctl -u muse-link -n 80 --no-pager`。

## 注册 hook 与常驻 worker 协议

脚本 `~/hooks/scripts/muse-link-wechat.sh`，建议 poll_interval_secs=5，以实际平台支持为准并记录生效值。Muse 必须把 wake/silent 输出适配成平台实际协议，先 dry_run 再 enable；dry_run 不得 pull。记录真实 hook 标识、启用状态、检测间隔和 worker 工具权限。更新或替换旧 hook，不要两套同时运行。分别配置主级池维护提示与常驻worker执行协议；检测脚本仍只读，不把消费者循环写进探针。

平台调用 outcome=wake 不证明任务已运行。保留实际 HATCH_HOOK_RESULT 适配，每次单结果，内部检测器不双重包装，先 dry_run。按 [自动唤醒与交接](AUTOMATIC_DISPATCH.md) 核对投递与恢复边界；常驻池无需逐条等待该路径，但全池死亡/刷新后的自动重建仍须单独验证。

按 [常驻池协议](NATIVE_PARALLEL.md) 和 [完整恢复指令](给Muse恢复常驻worker的指令.txt) 由主代理将真实常驻池补齐到默认 6 个；已有健康者保留，只新增缺失 slot。各自 next、保存独占原交接、处理并直接回复、再 next；子代理不需要派生权限。空队列继续长轮询，独立结果按完成顺序回传，所有槽忙仍排队。新消费者实际消费后再结束旧职责，已领取事件保留原所有者。

只读探针不领取或清理 claim；它与常驻消费者不是同一角色。hook 唤醒主代理时先查真实 slot/handle，核对后补齐缺失常驻者，不逐条创建执行者。surface=main、health 或 dry_run 通过不能证明自动补位；没有真实运行入口则标自动恢复未接入。

下列协议由各常驻 worker 直接执行，每次领取新事件并保存独立文件，不共用当前 token。空闲无维护截止时 --wait 35s；有异步回执/续租/工具结果时 --wait 1s。--limit 1 是单次领取量，不限制全池并行。rc.6 tool-job 仅控制可信脚本资源，不创建 Muse worker；各池员共用策略，不另建队列绕过 CPU 上限。

外部生图/API任务必须遵守 [次数与总耗时上限](EXTERNAL_API_TASKS.md)：由独立执行者运行，不占住调度者；HTTP单次超时不能代替整个任务截止。失败后不在主循环无限重试、换域名或换工具；生图提交结果未知时先核对，其他消息继续处理。桥的微信发送超时与外部生图超时是两套不同设置。

1. 每次唤醒先复查当前 status/health，必要时读 diagnose 与可用服务日志；核对告警的 UTC 检测时间，延迟到达的旧告警不代表当前故障。主级维护入口当前健康、池正常且无待办时可静默结束；常驻worker空队列则继续长轮询，不因旧告警重启，也不擅自重启用户主动停止的服务。有待处理事件时继续排空，不能因为 backlog 告警就永远不领取任务。
2. 各常驻 worker 按“跨班次交接”准备私密目录，每次 muse next --limit 1 --lease 30m --wait 35s --output <本次新私密目录/task.json>，保存完整 event_id/token/lease_until/execution/completion。rc.5 兼容路径见完整恢复指令。每 5 分钟本事件正常 renew 到 30 分钟，失败停止新操作。完成本事件后继续 next，不等主代理派发或新 hook。空响应/不完整响应分开处理，不能只靠聊天记 token。
3. completion.state=unknown/rejected：先核对请求和手机，不重做任务或换 ID 发送。failed 且 retryable=true：恢复原进度和生成文件，修复原因后用原文字/路径续传，跳过已确认消息。不要重新生成整个结果。execution.needs_review=true 或存在 started 步骤时，核对外部系统、旧 worker 与工具结果，不能自动重复执行。
4. kind=alert：只在 Muse 聊天报告，再使用当前 token ack。普通事件读取 text、voice_text；media_errors 必须如实说明，不声称已读取入站附件。空事件可记录忽略原因后 ack。
5. 需要工具时使用真实 Muse 工具权限。对会修改外部状态、耗时昂贵或不应重复的操作，先以稳定 step 名写 started，成功后写 completed 和可恢复结果。示例（替换为本任务真实值）：

   ```bash
   muse-link muse checkpoint '<event_id>' --lease-token '<lease_token>' --step generate-result --phase started
   # 仅在 started 成功且未返回 cached 时，调用真正的 Muse 工具。
   muse-link muse checkpoint '<event_id>' --lease-token '<lease_token>' --step generate-result --phase completed --text - <<'TOOL_RESULT'
   工具结果或持久化结果文件路径
   TOOL_RESULT
   ```

   completed 返回 cached 时复用其 result，不再执行工具。中断后遗留 started 时停止并核对；确认外部结果后，用当前 token、同一 step、--phase completed --reviewed 写核对结果。核对不能用猜测替代。日志只能防止盲目重做，不能与外部系统组成事务，也不能停止已经执行中的旧工具；外部操作仍需自己的幂等键。
6. 结果准备好后立即提交微信，再写 Muse 的完成说明，不等下一轮 hook。最终回复自动路由并生成稳定 request_id，须带当前 token：

   ```bash
   muse-link muse reply '<event_id>' --lease-token '<lease_token>' --text - <<'MUSE_REPLY'
   回复正文
   MUSE_REPLY
   ```

   事件和 token 使用领取结果，不能照抄占位符。用带引号的 heredoc 和不会出现在正文中的分隔符，不把用户文字拼进 shell。微信只发真实结果，使用纯文本、无 Markdown；不发“收到，正在处理”等占位确认。仅在有实质阶段结果或已核实失败/阻塞时，用同一 reply 命令加 `--progress --reply-id '<稳定阶段编号>'`，控制频率、不编造预计耗时，不结束任务。普通问候直接回复，不额外占位。
7. 生成图片/视频后，用真实工具导出完整本地文件到 media_roots，在同一最终 reply 加 `--image '/absolute/result.png'`、`--video '/absolute/result.mp4'`。最多 4 个媒体，可省略文字；图片 20 MiB、视频 50 MiB，本包不转码。只有 URL/媒体 ID 时先导出文件。不要先最终回复文字结束任务再补图；预览用 --progress --reply-id preview。PrivateTmp 下跨进程文件应放持久化 workspace，详见 MEDIA.md。

   rc.5 的媒体回复使用 `--async`，先私密保存原回复正文、媒体路径和 task.completion.request_id，再提交。返回 submitted=true/state=pending 后保存回执，立即继续领取其他消息；每轮查看原 request，不在消息循环中同步等待该上传。pending 时仍按每 5 分钟续租，接受后桥自动 ack；通知只能在 accepted 后结清。上传期间同一聊天的短文字可先发出，长任务结果要指出对应原请求。强制重启不会自动重发未完成异步请求，失败按下一项恢复。
8. accepted 只代表微信 API 确认，不代表手机显示/播放。调用中断先 `muse-link request '<request_id>'`；unknown 不自动重发，核对后可用 review 记录处置，但不会变成可重发。429/503/507 先检查状态，修复或等待后使用同 ID/内容重试。failed 可安全续传的情况不重做生成；持续失败要报告并保留交接记录。
9. 最终 reply 成功自动 ack。告警、空事件、无需回复或核对后结清的事件，用 `muse-link muse ack '<event_id>' --lease-token '<lease_token>'`；未完成工具步骤不能 ack。未完成不提前确认，持久化业务结果/文件路径以备恢复。可准确记录结果就绪时间时才使用 --ready-at，不能把发送调用时刻冒充模型完成时刻。
10. restore_review_required 时停止，不绕过闸门；按照 PRODUCTION.md 核对恢复后可能重复的微信和工具动作。72 小时验收按“给Muse生产验收的指令.txt”，保留脱敏证据。

## 跨班次交接

主代理负责创建、查询和轮换池，普通子任务可以作为直接 next/reply 的常驻消费者，无需再次派生。按 AUTOMATIC_DISPATCH.md 先确认新 worker 运行，再令旧者停新 next 并收尾；其他 slot 继续消费，不要求全局唯一领取者。已有事件仍只有一个所有者，转移前核对旧执行者与工具已停止，不能因为换班重复外部动作。

rc.7 可由 CLI 为每次领取管理独立私密目录；把非空返回的 handoff_file 写入 Muse 持久化交接记录，后续班次先检查未完成记录，再领取新任务：

```bash
umask 077
mkdir -p "$HOME/.local/state/muse-link-worker"
chmod 700 "$HOME/.local/state/muse-link-worker"
WORKER_ROOT=$(mktemp -d "$HOME/.local/state/muse-link-worker/worker.XXXXXXXX")
# 本slot启动时创建一次，后续领取复用这个根目录，不能用其他slot的路径。
muse-link muse next --limit 1 --lease 30m --wait 1s \
  --output-dir "$WORKER_ROOT/claims"
```

CLI 在请求前独占创建 0600 文件，拒绝覆盖旧记录；父目录须为私密真实目录。成功响应先写入并 fsync，再输出给 Muse，文件保存原始 tasks、endpoint 和 config_path。它包含正文和 token，只能本地读取和私密备份，不能上传仓库、粘贴进用户聊天或日志。该目录不属于桥的数据库备份；任务确认完成后按业务保留要求清理。工具结果、回复正文和生成文件位置仍需另行持久化。

--output-dir 仅在确认本次响应 tasks=[] 后删除自己持有的文件和空目录，返回 handoff_file=null；非空、网络/写入失败、未知响应或目录/文件身份变化均保留，不递归删除。旧版 --output 仍兼容且不自动删除。所有 hook/单轮探针禁止 next 和 rm -rf claim.*；探测改用只读 health/diagnose。既有空目录不自动清除，需先停止探针，逐个核实确为空、无交接/执行者归属，再另行维护，不混入在线恢复。

刷新恢复见 [运行环境恢复](RUNTIME_RECOVERY.md)：主代理重建真实 worker 池，普通子任务继续各自直接领取。刷新保留文件不代表旧任务存活；缺真实主级启动入口时不能声称自动恢复。

接班前先确认旧 worker 及其后台工具已结束或停止，再读取原文件；核对 config/endpoint、步骤和稳定 request_id。原 token 仍有效时可通过正常 renew 验证后接续，已 accepted 的回复只核对原请求，不重新执行。started 步骤先核实实际结果；换班本身不允许重复外部动作。不要并发运行两个 worker 使用同一交接文件，也不要直接从数据库取 token 接管。

若没有原文件或 token 已丢失，不能声称“与数据库一致”。缺原 token 时等当前租约到期后正常领取，并核对旧工具与 completion；不要清库或手动改 token。若 CLI 崩溃在响应保存之前，文件可能是 awaiting_response 或不完整；这也需要诊断，不能当成没有领取。磁盘写入失败时 CLI 退出非零并保留原响应在 stdout，须私密保存并报告，不能继续静默处理。长租约能保护正在运行的工具，但 worker 丢失交接记录时也可能使消息等待到期，本版不自动强抢活跃租约。

## 从原交接文件读取租约（本地待验证修订）

以下 `--task-file` 是候选CLI功能，rc.5及较早的rc.7源码不包含此参数；使用本次修订后的源码不代表云端已升级。先核对实际运行的CLI帮助是否列出该参数；仅看到版本号相同不够。用户验证前不据此升级云端。

使用本CLI通过 `muse next --output` 或 `--output-dir` 保存的原始领取文件，可避免手工复制、截断token；event_id仍必须显式提供：

```bash
muse-link muse renew '<event_id>' --task-file '/private/task.json' --lease 30m
muse-link muse reply '<event_id>' --task-file '/private/task.json' --text - <<'MUSE_REPLY'
实际结果
MUSE_REPLY
```

`muse checkpoint` 也可用相同参数，step/phase/result约定保持原样。只读原文件中与event_id唯一对应的完整租约；父目录应0700、文件0600且不能通过符号链接读取，领取与回复须用相同配置路径和后台地址。文件包含正文/token，不能粘贴到聊天、日志或仓库。该参数不能与 `--lease-token` 同用，不适用于ack，不修改原文件，不从数据库读当前token；真正过期或被后续领取替换的旧租约仍被桥正常拒绝。

失败后保留原交接和脱敏的命令退出码、错误JSON，核对原request状态与真实执行者。只有文字称stale_lease而无原始输出时应记“拒绝未证实”，不能自动改为过期或桥误拒绝。执行者done但原final未accepted仍须对账；接管前确认同事件原执行者及工具已停止、操作结果与唯一接管责任，使用原交接和稳定request，不复制数据库当前token或重做未知外部操作。

## 验收

请用户先从微信向 ClawBot 发一句短消息。Muse 回复后核对手机是否收到，保存 event_id、request_id 和 timing，查看 muse-link metrics。

再从微信发“请实际调用 shell 获取当前 UTC 时间和 Node.js 版本，把结果回微信”。检查真实 worker 工具调用记录，确认执行结果已回到手机；简单问候或假 worker 不能作为此项通过。记录事件 received_at、worker 启动时间、真实结果就绪时间（可获得时）、发送返回的 accepted_at 和手机收取情况。最后核对长回复、服务重启、相同 ID 重试。

再测试实际生成的小图片与短 MP4 回传，记录真实文件路径、media_upload_ms、send_message_ms，核对手机可打开图片、播放视频。更换旧 hook 的“只能回文字”指令后仍需此项验证；本地视频协议测试没有验证手机播放。

timing 测量桥处理与微信 API 确认，不测手机显示时间。Muse 完成后很久才收到时，先比较 model_to_submit_ms 与 upstream_ms，再核对手机显示时间；不要把 35 秒长轮询当成发送的固定等待。比较旧方案须在相同云端、代理和相近内容长度下实测。本地模拟结果不能当作微信速度。

若健康但不回复，先按 [排查说明](TROUBLESHOOTING.md) 采集该事件的状态。stale_lease 不一定是过期，也可能是已 ack 或 token 不匹配；不要仅凭服务重启推断状态残留。普通问候无需写工具 checkpoint，外部工具步骤才按上面的约定记录。
