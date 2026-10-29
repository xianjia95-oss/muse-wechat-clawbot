> 速度优先模式另见[AUTOMATIC_TEXT.md](AUTOMATIC_TEXT.md)：本地程序领取/分发/校验/回复，两个真实Muse任务处理文字，不再由负责人逐条二次推理审核。两种模式须安全交接，不能同时消费。下文的人工负责人审核流程仅适用于仍选择该模式的部署。

# 固定对话负责人和后台任务（本地候选）

同一微信会话由固定的真实 Muse 常驻任务理解上下文、关联操作并回复。耗时操作在有界后台运行，执行者只返回结果，不直接与用户对话。桥不调用 Muse 模型、不创建原生任务，也不能赋予原生生图或视频权限。

**修正：一个负责人加本地工具后台，并不等于多个Muse任务并行思考。** 复杂文字由负责人自己处理时仍串行。当前候选新增[两个真实Muse执行者的私密草稿邮箱](MUSE_EXECUTORS.md)，主代理提前启动1负责人和2执行者，执行者直接轮询邮箱、只产草稿，负责人统一答复。不能把“唯一回复者”解释为“必须完成一条才能领下一条”。云端是否启用须核对三个真实任务和匹配源码，不能凭文档宣布已完成。

本方案需要本地候选源码中的新接口。未升级的 rc.5、已有 GitHub 标签和同版本号旧包不支持；只替换提示词或把六个 worker 改成一个不会完成改造。未启用新会话时，后台保留 legacy_workers 协议以便受控迁移。

## 已实现的控制

- `muse session start` 原子开启 coordinator 模式并发放唯一会话凭证，只保存到私密文件。存在有效旧租约或发送时拒绝切换；不能清租约来绕过。
- coordinator 模式的领取、回复、续租、步骤、历史和确认都要求会话凭证；旧消费者即使还在长轮询也不能继续领取。禁止直接 send 绕过事件路由。一个负责人同时只能挂起一个 next，每次领取一条；桥全局最多保留32个有效租约，达到上限先维护未完任务。
- 会话凭证有效期5分钟；正常调用按需延长，不会在每个轮询周期写盘。原凭证在未被替换时可显式 renew；替换后旧凭证失效。stop 不恢复旧多消费者模式。开启时数据库user_version升至2，旧桥会拒绝打开，防止只回滚代码就绕过会话控制；恢复旧版需按备份与副作用对账流程独立安排，不能手改schema版本。新负责人不能在有效事件租约未交接时抢占。
- `muse context`读取当前发送者的近期请求、实际回复、未完任务和持久摘要；`muse remember`用revision防止旧摘要覆盖。next --with-context默认compact：最多4条近期消息、每条最近1个回复，文本/转写/回复各最多512个JSON字节，摘要最多2KiB，整个context最多16KiB。原事件正文和原始领取文件不截短；context内所有裁剪均有标记。需要更完整的上下文时，用原task-file执行muse context --context-mode full（直接context默认full），仍最多20条近期请求、各5条回复、240KiB，并非无限历史。任务窗口有tasks_truncated；查询不修改原记录。长提示词须保留完整原领取文件或私密引用，不用摘要猜测补全。摘要存储最多16KiB，默认保留7天。
- `muse task` 保存 queued/running/waiting_for_authorization/ready/failed/cancelled 及真实后台handle、关联事件和简短结果。running 最多2项，等待授权单独记录。终态不能变回执行中。未完任务禁止 final 或显式ack；原有 checkpoint started/unknown 仍须核对，不能仅改task状态绕过。
- 正常回复拒绝已知内部身份/领取协议叙述和本次已知活动凭据；用户明确询问公开技术可以解释。该有限匹配不能判断所有泄漏、答案正确性或是否真生成了媒体，仍需真实工具记录与手机验收。
- 对用户称呼只使用用户明确确认的信息。仓库所有者、部署用户名、路径片段和历史助手自述不是用户姓名证据；未设置姓名时使用中性称呼。出现错误姓名先核对实际Muse提示词/记忆来源，不将未经证实的称呼写入remember。桥的有限匹配不能完全阻止模型自行推断身份。

会话凭证用于防止误操作与争抢。同一OS账号能读取文件和配置，因此它不是隔离恶意执行者的安全沙箱。不要把会话文件或事件租约交给只负责运行工具的执行者。普通status/health/diagnose不输出这些凭证、摘要或正文。

## 安全切换

1. 先准备配套代码、真实常驻入口及工具权限，不为改指令清登录或状态。升级按[MUSE.md](MUSE.md)备份和交接。核对实际CLI帮助含`muse session`，后台支持新接口；不能只看rc.7版本字符串。
2. 旧消费者先停止新next，完成或持久化交接持有事件及外部工具；查询真实handle确认归属。待有效租约和inflight发送归零，再start。暂时无法安全排空就保留旧负责人收尾，不强抢租约。准备交接者后再退出旧者，不能先停全池再依赖慢hook。
3. 由一个具有所需工具权限的真实Muse常驻任务持有会话文件。不是每条消息等hook唤醒主代理；也不把普通子任务改名就当成具备主级派生或视频权限。

```bash
umask 077
mkdir -p "$HOME/.local/state/muse-link-conversation"
# 首次使用新文件名，不能覆盖已有会话；只在私密终端执行。
muse-link muse session start \
  --session-file "$HOME/.local/state/muse-link-conversation/session.json"
```

start成功后凭证已保存，stdout不输出凭证。中途没有完整响应或写盘失败，保留文件和现场，先核对服务状态，不盲目再start。不要从SQLite抄会话或事件token。每次换班共享的是原始私密交接，不能仅用公开任务名认定所有者。

## 普通短消息的最小循环

协议没有每条固定耗时或“回复后才能领下一条”的要求。独立问候通常只需两次工具调用：next --with-context取得原事件及精简上下文，然后用原task/session reply --async给真实短答；原final accepted后桥自动ack。无需每条另外context、health、diagnose、remember、task、checkpoint或显式ack。只有上下文不足、确有新长期事实、后台任务或外部动作才走对应分支；不要把部署检查步骤放进日常聊天循环。不能跳过尚未完成的后台task或started步骤。

每轮仅维护实际有变更或已到期的项目，汇总查询草稿结果，避免反复打印完整历史、日志、claim和全部任务台账。复杂独立文字提交两个已运行的真实执行者后继续next，不由负责人同步思考完再审核自己的答案。纯文字最终回复仍只发真实答案，不能为提速发送占位句。

遇到相关追问、notes_truncated、所需正文截短或tasks_truncated时，按需读full/context或精确history；不是每次遇到任何截断标记就全量重读。更新remember之前，若notes_truncated=true，必须先读full原notes及当前revision，不能拿精简摘要覆盖完整记忆。context_mode/context_bytes/context_build_ms只说明桥返回的载荷与构建耗时，不包含Muse推理、原生调度或手机送达。

Muse原生任务自身的对话日志仍可能增长，桥无法清除它，也不能用session renew让模型上下文重置。若同类短消息在长时间运行后变慢，先对比入库→领取、领取→提交、提交→accepted三段及真实角色状态，不能仅按运行时长认定根因。确需换班时由具备真实工具的主代理准备待命接续者、私密保存原session/未完claim/草稿/工具引用与精简交接，确认旧负责人不再next/reply后再激活接续者；不新建session、不丢租约，不先停旧者再等hook。没有真实自动交接入口时只能报告需主代理接班，不能假报自动轮换。

## 负责人持续循环

以下命令展示接口，`EVENT_ID`和`TASK_FILE`必须取自本次原始领取。所有正文和输出只在私密环境读写，不照抄成无限领取却不处理的shell循环。

```bash
SESSION_FILE="$HOME/.local/state/muse-link-conversation/session.json"
CLAIMS_DIR="$HOME/.local/state/muse-link-conversation/claims"
muse-link muse next --session-file "$SESSION_FILE" \
  --limit 1 --lease 30m --wait 35s --with-context --output-dir "$CLAIMS_DIR"
# 普通消息已附context；旧领取或context_error才补读：
# muse-link muse context "$EVENT_ID" --task-file "$TASK_FILE" --session-file "$SESSION_FILE"
```

1. 每轮先核对已有工具结果、等待授权、未决发送及续租。所有持有事件每5分钟用原task-file正常renew到30分钟；会话空闲轮询也维持owner存活。剩余时间不足时先续租，不能开始将超出租约的排队操作。
2. kind=alert仅在Muse私密环境核对后使用会话及原租约ack，不发微信，不调用要求用户路由的context。普通消息有草稿、后台工作或回执待维护时用`--wait 1s`，全部空闲才35秒；新消息会提前返回。next加`--with-context`直接读取附带上下文，识别是独立新任务、追问还是取消。context_error须保留原领取补读，不忽略。每次一条与必须答完才领取不同，负责人可以保留多条未完事件。
3. 简单问题立即答复。复杂独立文字按MUSE_EXECUTORS交给两个提前启动的真实原生执行者，提交即继续next，不自己同步完成全部分析。长工具必须使用实际可异步提交/查询的入口，保存handle后立刻继续next；不在对话循环同步curl、sleep或等待生成。不能把一段思考提示词“后台执行”当成真实任务。
4. 队列不是模型数：后台最多2项活动，CPU密集工具最多1项；超出时持久化queued，负责人仍答短消息。不能逐条预领无限任务，也不能等一整批全部完成才回收结果。
5. 工具只读自己的输入，结果写私密文件或平台任务输出；不持有会话凭证、不next、不reply、不清claim、不代表用户扩大权限。负责人核实实际结果后统一反馈。独立结果谁先完成先反馈；“再用刚才提示词”明确关联原事件，不能随机执行。
6. 真正域名/额度批准仍在原平台完成。访问可能触发暂停时，只允许在已验证的独立执行入口发起；负责人不直接触发会阻塞自身的授权工具。无法隔离时先告知具体权限阻塞，暂停这项访问、继续处理短消息。不得以微信“同意”代替平台批准。
7. 返回内容必须是实际答案、实际产物或已核实阻塞。不能发内部身份、命令、租约、私密路径、提示词协议；用户主动问项目技术再按需解释。不能宣称“已生成”后才发现文件不存在。出站媒体先核对文件、类型、可读性和media_roots，发送accepted仅证明腾讯接受，手机可打开/播放单独核对。入站图片/视频/语音按[MEDIA.md](MEDIA.md)，用原task-file/session-file执行muse media取得ready私密文件，再使用当前真实支持的原生工具读取；queued/downloading时保留原事件、续租并继续next，不同步等待。不支持读取/转换失败时如实说明，不能只看文件名或转写就声称已经看过/听过；附件不得提交给纯文字草稿邮箱。
8. 只有实质结果/已核实阻塞才用稳定progress/reply-id；progress不完成事件。不能用纯占位final清队列。结果就绪使用原task-file与session-file回原事件，accepted自动ack。等待草稿、工具或异步发送回执期间也继续next及维护，不等待此前一条完成才领取。

更新摘要示例（revision取context，stdin为当前完整摘要，不追加猜测）：

```bash
muse-link muse remember "$EVENT_ID" --task-file "$TASK_FILE" --session-file "$SESSION_FILE" \
  --revision "$MEMORY_REVISION" --text - < /private/current-notes.txt
muse-link muse task "$EVENT_ID" --task-file "$TASK_FILE" --session-file "$SESSION_FILE" \
  --state running --revision "$TASK_REVISION" --text - < /private/task-detail.json
muse-link muse reply "$EVENT_ID" --task-file "$TASK_FILE" --session-file "$SESSION_FILE" \
  --text - < /private/verified-answer.txt
```

task-detail仅允许kind=tool/native/chat、handle、summary、related_event_id，总计2KiB。running需要真实tool/native handle。更新时细节合并，已有执行者handle/kind不可替换；revision从0开始，每次成功加1，冲突先读context。task状态是负责人报告，不是平台任务查询结果：桥不能验证handle存在或权限已批准，不能用伪造ready冒充成功。

## 可信脚本后台入口

沿用[后台工具队列](BURST_MESSAGES.md)的真实Linux监督器。本模式应显式设置共享job目录策略：

```bash
node scripts/tool-job.mjs configure --dir "$JOBS_DIR" \
  --max-active 2 --max-io 2 --max-cpu 1 --max-queued 32
```

外部操作前保存稳定checkpoint started，再用稳定job ID执行`enqueue --script <可信本地mjs> --kind io|cpu --timeout <有界时限> --start-before <原事件租约内UTC>`；完整参数见BURST_MESSAGES。返回后立刻继续处理微信。每轮list/status/dispatch，只读取完成项的受限私密输出，核对结果与副作用，记checkpoint completed和task ready/failed，再统一回复并settle。未知结果保留核对，不盲目重试；不要让脚本自己调用微信或模型来冒充原生能力。

Muse原生图像/视频须核实当前角色能否异步提交、返回真实handle并查询结果。普通子任务不能再派生时，不能把后台脚本当原生模型API；没有可用入口就明确该能力未接入，保留正常文字与可信工具通路。自动化恢复也需要平台真实入口；不能用本地协议测试宣布原生能力已通。

## 验收和恢复

独立监控的本地实现、平台适配和启用流程见[OWNER_WATCHDOG.md](OWNER_WATCHDOG.md)。默认15秒检测，连续3次权威确认退出才恢复；探针不续会话，未知状态/授权等待不重启。平台适配和刷新后入口尚未验证，安装不会自动开启恢复。

部署后核对：

1. 主聊天不人工操作，微信连续两批短消息自动回复，同一负责人持续消费。
2. 发长提示词，再分别说“按刚才的提示词生成”“换一个场景”；不重复索要已保存内容，正确关联原任务。
3. 一个90秒无副作用后台任务运行时，短消息在其完成前回复；后台多项独立结果按完成顺序反馈。每条都核对实际内容和手机，不用accepted总数替代。
4. 两个后台槽占满时，额外操作queued；短问题继续。已存在授权等待时也测一条短消息，不重新访问真实域名制造提示。无样本记未执行。
5. 正常任务回复不含内部身份/命令/路径。能力不够时统一解释具体缺口，不相互矛盾、不编造成功。真实图片视频逐项验收；未接通记未执行。
6. 换班/服务重启读原会话文件renew并接续原任务；负责人丢失只能使用原私密交接或等待有效租约到期。环境刷新杀死进程后，仍需真实平台恢复入口，无入口报告“刷新后自动恢复未接入”。持久化上下文不保证任务自动存活。

session文件、摘要、近期聊天、handle与工具结果均为私密数据。SQLite及备份含摘要和任务细节，无额外应用层加密；默认沿用7天事件保留，查询隐藏到期摘要、维护批量逻辑删除。长期未确认事件保留任务以便安全核对；旧备份、WAL及空闲页物理清理独立管理。不能将现场材料放公开文档或Git历史。
