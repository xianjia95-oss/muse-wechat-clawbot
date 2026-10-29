# 固定对话负责人的独立监控与恢复（本地候选）

本地候选已实现独立监控进程、只读会话探针、恢复意图持久化、单实例锁和退避保护。**Muse平台原生任务的查询/启动适配器尚未接通；安装桥或复制示例不会自动创建Muse worker。** 完成真实适配和下面的验收后，才能报告自动恢复通过。未经用户验证不推送、不发布。

目标是一个固定对话负责人持续消费微信，退出后由独立监控恢复原上下文及交接。后台最多2项活动任务；监控不参与日常逐条派发，不退回六个独立聊天消费者，也不等待hook投递后才处理每条消息。

## 判断和保护

- 默认15秒检查一次。只有平台连续3次**明确确认退出或该固定slot不存在任务**才进入恢复，通常确认需30–45秒，另加查询和平台创建耗时。这是配置节奏，不是云端恢复时延承诺。
- running、starting、waiting_for_authorization都不创建替代者。会话心跳过期但平台任务仍running只报告worker_heartbeat_stale，不杀任务。授权等待不冒充断线；负责人应按CONVERSATION_OWNER的独立后台方式隔离授权。
- 平台超时、unknown、列表不完整、旧handle查不到、多个活跃负责人时均停止创建并报告。worker_backlog和HTTP 503不直接用作重启依据。
- 监控通过原私密session的probe核对当前后台。探针不领取、不回复、不ack、不renew会话或事件；即使原会话已过期也可核对，已被替换/关闭的旧会话不能恢复。维护/恢复审核时暂停。
- 恢复者使用原session和原claims目录，先查询原工具/远端结果，核实旧原生任务已终止，正常续接原租约。监控不执行session start、不读SQLite的token、不清租约、不重跑外部API、不替用户批准域名。
- 启动前先将固定recovery_id、原任务handle、重试时刻和次数私密持久化。超时/丢响应/监控自身重启后保留同一个ID；先查任务，再按原ID核对。退避30/60/120秒，最高300秒；15分钟内最多3次ensure调用，超过报告recovery_rate_limited，窗口结束后仍使用原ID。
- 同一state_dir只有一个监控可运行，OS锁在进程崩溃后释放。状态写盘失败时不发起新的启动。owner-watchdog.json含私密handle和交接关联，不上传；普通stdout只含受控状态码、UTC及有限布尔值。

## 平台适配器契约

从deploy/owner-adapter.example.mjs复制到0700私密目录。示例始终以未接入退出，**不能改成后台Node/shell假扮Muse**。适配器由Node以固定本地.mjs路径调用，单个JSON请求从stdin输入，stdout只允许一个JSON（最多16KiB），stderr不会转存到公共日志；默认10秒超时会终止适配进程，但不能撤销已经创建的远端任务。

首先核实平台是否提供本地CLI、SDK或API，能查询真实原生任务并创建具备对话工具权限的负责人。只有主聊天内的subagent工具并不等于本地程序已有调用入口。没有入口就保留adapter_script为null、recovery_enabled为false，报告“自动恢复未接入”，不拿hook wake或cron通知替代真实启动证据。

slot是部署级固定归属。**启用前把现有负责人真实handle注册到该slot**，保证完整查询可发现它；不能只搜监控创建过的任务而漏掉原负责人。平台刷新后残留任务目录不能算存活。适配器必须能权威列出该slot并直接查询tracked_handle；权限不足/查询失败时退出非零或报告unknown，不能返回空数组冒充无人运行。

inspect输入：

```json
{"protocol":"muse-link-owner-watchdog/v1","action":"inspect","slot":"wechat-conversation-owner","tracked_handle":"native-example-previous"}
```

inspect输出，owners是该slot完整的原生任务记录；tracked_handle非空时必须单独返回对应状态：

```json
{"protocol":"muse-link-owner-watchdog/v1","slot":"wechat-conversation-owner","authoritative":true,"owners":[{"handle":"native-example-previous","state":"running"}],"tracked":{"handle":"native-example-previous","state":"running"}}
```

状态只接受starting/running/waiting_for_authorization/completed/failed/cancelled/terminated/unknown。handle为1–256位字母、数字或_.:-。首次尚未跟踪任务时tracked_handle为null；真实确认slot无任务时owners可空。旧handle查不到不等于terminated；无法证明就返回unknown。

ensure请求在确认退出后发出，除inspect字段外还包含：

```json
{
  "protocol":"muse-link-owner-watchdog/v1",
  "action":"ensure",
  "slot":"wechat-conversation-owner",
  "tracked_handle":"native-example-previous",
  "expected_previous_handle":"native-example-previous",
  "recovery_id":"00000000-0000-4000-8000-000000000001",
  "handoff":{
    "bridge_config":"/home/muse/.config/muse-link/config.json",
    "session_file":"/home/muse/.local/state/muse-link-conversation/session.json",
    "claims_dir":"/home/muse/.local/state/muse-link-conversation/claims"
  }
}
```

适配器须在**同一原子/互斥流程**重新核对slot和旧handle，遇到已有活跃者返回该任务，不重复创建；针对recovery_id持久化去重，创建结果未知先查原请求，不能换ID重试。单纯“先list后spawn”存在竞态，不符合契约。平台不能提供幂等创建时，适配器需实现可靠的唯一归属及未知创建核对；做不到就不得开启恢复。

ensure成功输出沿用inspect格式，增加原recovery_id，owners包含真实新handle（starting或running），tracked继续说明旧任务已终止。不得凭创建请求已发出就返回running；并发控制、原生handle真实性、历史任务完整性和跨刷新去重由可信适配器负责，桥无法独立证明。

新任务使用原始私密session renew，继续原负责人循环。原已领取事件有完整原task文件则正常续租；缺文件先保留现场，等有效租约到期后正常领取。已accepted最终回复不重发，started/unknown外部效果先核对。监控仅恢复负责人，不重新派发每个后台工具。

## 配置和手动检查

### 平台主级定时巡检路径（没有本地任务API时）

本三版本负责人包优先按 [RUNTIME_RECOVERY.md](RUNTIME_RECOVERY.md) 由原主聊天登记巡检、接收正式平台自动通知并查询/补位。独立巡检只能看到自身子树时记 unknown 并通知主聊天，不能据此判定现任负责人死亡或主聊天无创建权限。自动投递与主聊天权限分别实测；本地适配器仍保持未接入。下面由定时运行自身直接查询和创建的路径属于可选方案，只有选择它时才要求该运行具备原负责人的完整查询范围。用户手动输入恢复指令不算自动通过，原主聊天被平台自动触发后执行则依据原始记录核验。

本地监控保留adapter_script为null、recovery_enabled为false。check/run仍保存真实session探针的owner_active及pending/ready/leased计数，并明确native_task_query_available为false；状态写在独立state_dir/owner-watchdog.json的last字段。它不能区分任务退出、授权暂停和模型繁忙。主级定时巡检直接运行check也可，不要求另一个后台监控始终存活。

由Muse主代理使用**实际存在的平台定时任务工具**，先建一次只读验权运行：证明该定时运行能调用原生subagent.list并看到现任负责人的真实handle。若只在主聊天交互时能调用、定时运行变成无权限子任务，或看不到原负责人，不能启用创建逻辑。只有此项成功且平台支持巡检不重叠执行，才能创建每分钟的独立主级巡检；不是Linux crontab执行shell，也不是每分钟再发一条hook wake。

每次运行先读探针和平台原生任务状态，复核旧handle；running/授权等待/starting保留，unknown不创建。会话到期或积压本身不证明任务死亡。仅确认原任务已终止且无替代负责人后，记录私密恢复意图及固定关联标识，在该次具备权限的对话运行内调用subagent.spawn，保存返回的真实handle和原交接。保存前后异常或创建结果未知，下一次先查原生任务核对原请求；无法排除已创建时不得再spawn。定时运行互斥与原生创建去重须由平台能力或经验证的私密恢复台账保障，不能靠普通文件mtime推断。

该路径的判断/创建发生在平台对话中，**没有通过本地adapter ensure**；本地监控仍应显示未接入本地原生API，不能伪造adapter成功。另记录平台定时任务的真实注册ID、权限测试结果、实际执行时间、恢复handle和手机结果。每分钟只是计划周期，不保证一分钟恢复；调度投递延迟和平台刷新后注册是否保留分别实测。主代理手动救援不算定时恢复通过。完整给Muse指令见[给Muse启用负责人自动恢复的指令.txt](给Muse启用负责人自动恢复的指令.txt)。

先完成固定会话切换，保留真实负责人运行。复制deploy/owner-watchdog.example.json至~/.config/muse-link/owner-watchdog.json，文件0600、所在目录0700，按实际环境设置规范绝对路径。session_file必须是原文件，claims_dir已存在且0700；state_dir独立于桥state_dir，父目录须存在，不允许符号链接路径。不要把session文件放入公开配置示例。

未适配时也能检查并明确显示未接入：

```bash
node scripts/owner-watchdog.mjs check --config "$HOME/.config/muse-link/owner-watchdog.json"
```

check始终只观察（会保存私密监控状态，不调用ensure）。完成适配与隔离验收后设adapter_script为真实私密脚本路径，并显式设recovery_enabled为true：

```bash
node scripts/owner-watchdog.mjs once --config "$HOME/.config/muse-link/owner-watchdog.json"
node scripts/owner-watchdog.mjs run --config "$HOME/.config/muse-link/owner-watchdog.json"
```

once运行一个周期，run持续运行。配置只在进程启动时读取，修改后正常重启监控。切换slot/适配器/交接路径时，旧状态仍有不确定启动请求须先核对，不能删状态或换目录绕过去；状态作用域不一致拒绝启动。手动维护应先正常stop监控服务，避免把计划中的负责人退出误判为故障。

## 独立服务和环境刷新

提供deploy/muse-link-owner-watchdog.service.in，与桥服务分开管理，监控进程异常时systemd尝试重启。安装器不会默认启用它，防止未验证平台适配时误创建任务。在运行中的Linux systemd环境，由部署者将模板中的__HOME__/__USER__/__NODE__替换为实际值，按已有桥服务相同权限安装为/etc/systemd/system/muse-link-owner-watchdog.service，daemon-reload后enable --now；不是把模板直接复制就启动。不要用sudo启动整个Muse聊天任务。

查看/暂停：

```bash
systemctl status muse-link-owner-watchdog.service
journalctl -u muse-link-owner-watchdog.service -n 30 --no-pager
# 计划维护先停监控；仍按原流程交接事件。
sudo systemctl stop muse-link-owner-watchdog.service
```

systemd服务恢复仅覆盖服务管理器和配置仍存在的情况。**整个Muse运行环境刷新若杀死进程并清空systemd注册，本地监控也会消失**；还须将恢复唯一桥、启动本监控的流程接入平台真实的刷新后启动入口。文件保留、当前监控在跑、或cron存在都不能证明该入口接通。没有平台入口明确记“刷新后自动恢复未接入”。

## 必须验收


1. 保持真实负责人运行，多次check不会创建第二个任务；授权等待、running但心跳过期、平台查询失败均不重启。
2. 在无外部副作用的受控窗口结束负责人，主聊天不操作。记录平台确认退出、恢复请求、真实新handle、续接和手机回复时间；只从微信发消息验证恢复。
3. 结束负责人前先保存一条原始领取文件。恢复后用原会话和原租约完成，不从数据库复制凭据，不重复回复或重做外部工具。
4. 模拟启动回执丢失后，查询真实任务与原recovery_id；不得多建一个。并发启动两个监控只允许一个获得锁；维护暂停不启动负责人。
5. 监控本身退出后由独立服务管理器拉起，原pending ID保留；整个环境刷新另行验证平台启动入口，不能混为同一项通过。

只有真实任务和手机结果核实后，才报告相应项通过。没有平台接口时交付本地实现和明确的未接入项，不承诺自动恢复时延。
