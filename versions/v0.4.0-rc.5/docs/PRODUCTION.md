# 生产运行与验收

当前版本 **0.4.0-rc.5** 是生产加固候选版。代码和本地故障测试不能证明 Meta Muse 的实际 hooks、微信账号收发和手机媒体播放已经通过。完成本文的真实验收后，才能为该部署作出上线判断。

## 运行范围

一个微信账号、一个常驻实例、一个持久化本地磁盘目录。Node.js 24 + SQLite WAL/FULL，不需要 Redis、数据库服务或公网入站端口。Linux 部署使用 systemd，Windows 可用于开发和协议测试。不要在 NFS/SMB、临时容器层或多副本共享卷上放置 state_dir；不提供跨主机高可用。Muse 云实例休眠时，桥也无法接收消息。

服务、登录、维护、备份和恢复均使用 state_dir 同级的 SQLite 独占锁；更换 HTTP 端口也不能启动第二个所有者。进程被强制终止后由操作系统释放锁，不依赖删除 PID 文件。不要删除运行中的 `.lock.sqlite` 或其辅助文件。`inbox count` 是只读诊断，服务运行时可用。

API 只监听 loopback，除存活探针外都需要私密 token。用 init 生成真实配置；示例 token 无法通过校验。token 接受 32..256 个可见 ASCII 字符，不能含空格或控制字符，应随机生成，不使用公开或易猜值；已有随机十六进制和 Base64 token 可继续使用。限制 media_roots 到实际生成目录；不放入 HOME 根目录。systemd 的 PrivateTmp 隔离 /tmp，跨进程生成文件应导出到持久化 workspace。配置、SQLite、上传快照和备份含凭据或用户内容，不能上传公开仓库；Linux 目录使用 0700，文件使用 0600，Windows 需按服务账号设置目录 ACL。

本地 API 正文最多 256 KiB，上游 JSON 响应以流读取并限制 4 MiB，超出时失败关闭；工具步骤每项结果最多 16 KiB、每任务最多 1024 项。限制均为本项目的资源保护，不代表腾讯协议上限。

## 升级和回滚

1. 阅读变更，完成已领取任务或保存交接记录；暂停 Muse hook，停止服务。不要用新进程与旧桥同时轮询同一微信账号。
2. 从新版本解压目录运行 `bash deploy/install.sh`。依赖先安装在 releases 的候选目录，失败不会切换 current。已有状态会在切换前备份到 `~/.local/share/muse-link/backups/pre-upgrade-*`。保留配置和登录，不自动启动服务。
3. 更新 Muse worker，使用当前版本的 lease_token、renew、checkpoint 协议。旧配置省略 require_lease_token 时也默认为 true；旧 worker 不带 token 会返回 409，不能只升级后台。
4. 合并需要的配置，启动服务，确认 status.version=0.4.0-rc.5、health 通过；dry_run hook 后启用。保留上一版及私密备份。

普通用户为以下 systemctl 命令加 `sudo -n`：

```bash
systemctl stop muse-link
bash deploy/install.sh
# 更新 worker、配置，检查安装输出后：
systemctl start muse-link
muse-link status
muse-link health
```

代码回滚须暂停 hook、停止服务，清空待处理任务并核对所有 unknown 和未完成工具步骤，然后执行：

```bash
bash "$HOME/.local/share/muse-link/rollback.sh"
```

脚本先备份，再交换 current/previous、恢复保存的上一版 hook；不回退数据库、配置，不自动启动。新 schema 对 v0.3 的六列 sends 写入保持兼容，但旧版不具备新的租约和步骤保护；必须同步恢复匹配的 worker 指令。跨未来不兼容 schema 的回滚会被新程序拒绝，应使用对应版本及恢复演练流程。服务单元有独立 `.bak.*` 备份，回滚脚本不自动恢复单元或代理 env；变更这些文件时须由运维核对。

安装失败的候选目录会清理；已经成功安装的 releases、备份、失败恢复暂存目录不会自动删除。核对 current/previous、运行版本、恢复需求后，按路径清理旧副本，不要在安装根目录使用宽泛通配符删除。

## Worker 执行约定

环境刷新、服务单元重建、真实原生 worker 补位与静默巡检见 [运行恢复](RUNTIME_RECOVERY.md)。`runtime-check.mjs` 不推断 worker 存活；必须查询平台真实任务。`repair-service.sh` 只补缺失单元，不重新安装程序或自动启动服务。

完整指令见 [MUSE.md](MUSE.md)。领取返回 `event_id`、`lease_token`、`lease_until`、`execution.steps` 和 `completion`。租约最长 1 小时，长任务应在到期前续租，默认建议每 5 分钟续租到 30 分钟。续租失败立即停止发起后续操作；等待租约过期不能证明旧工具已经停止。

对会修改外部状态、耗时昂贵或不应重复的工具操作：先用稳定 step 名写 started，成功后写 completed 及可恢复结果，再进入下一步。completed 返回 cached 时复用结果，不再执行工具。恢复时有 started/needs_review，先核对外部系统和旧 worker 是否仍在运行，不能自动重复该操作；核对后用当前租约和 `--reviewed` 记录 completed。不要把“已写 started”当作工具已成功。

领取取消后不会再分配任务；已分配但响应未到达客户端的任务，仍需等租约到期恢复。排队回复及媒体上传后会在每次 chat 提交前重新校验租约。租约只能拒绝旧 worker 后续调用桥，不能撤销已经在网络中或已提交到外部系统的操作。步骤日志与第三方工具不在一个事务中，**不保证任意外部副作用恰好执行一次**。对于付款、发布等操作，仍要使用目标系统的幂等键和相应人工授权。

最终回复必须带当前 lease_token。accepted 后自动 ack；接收重复批次、重复回复、发送成功但未 ack 的重启不会自动再发。进度回复用稳定 reply_id。不要通过底层 send 绕过 Muse 的租约、路由与步骤检查。请将工具结果和生成文件路径也保存到 Muse 侧交接记录，单个 checkpoint 结果最多 16 KiB。

连续消息不能被同步外部工具长期挡住；rc.4 增加的 Linux 后台监督器与完成唤醒，须按 [BURST_MESSAGES.md](BURST_MESSAGES.md) 更新真实 worker/hook 才生效。它不调用 Muse 模型或自动完成桥事件，后台目录须独立私密备份，活跃工具不应在升级/回滚时被盲目重跑。仅替换 daemon 无法改变平台 worker 的阻塞执行方式。

## 容量与配置

把下列字段合并进原配置，保留 token、账号及其他字段；[config.example.json](../config.example.json) 是完整字段示例，真实配置用 init 生成。未配置 operations 时采用以下默认值：

| 配置 | 默认值 | 行为 |
| --- | --- | --- |
| max_inflight_sends / max_peer_sends | 64 / 16 | 包含发送及排队；满时新意图返回 429，不写入发送记录。相同 ID 的进行中/已完成请求仍复用结果。 |
| max_pending_events | 2000 | 未确认事件上限；整批接收事务回滚，游标不前进，待 worker 排空后恢复。重复事件不占新名额。 |
| max_http_requests | 128 | 活跃请求上限，满时返回 503；连接上限为其两倍。长等待也占名额。 |
| min_free_bytes | 134217728 | 保留至少 128 MiB 磁盘余量；不足返回 507。 |
| max_state_bytes | 1073741824 | 状态目录预算 1 GiB，包括 DB/WAL 和 outbox。 |
| max_outbox_bytes | 536870912 | 媒体快照预算 512 MiB；准备前预留空间，失败也会释放预留。 |
| backlog_warn_ms / poll_stale_ms | 300000 / 120000 | 可领取任务积压 5 分钟、上次成功轮询超过 2 分钟时 readiness 失败。poll_stale_ms 应大于实际长轮询超时。 |
| worker_stale_ms | 600000 | 有效租约 10 分钟没有领取/续租/checkpoint 活动时报告 worker_lease_stalled；持久化监测，不清理租约。 |
| event_retention_days | 7 | 完成事件保留 7 天，未完成步骤或未 ack 的事件保留。 |
| send_retention_days | 90 | 发送幂等记录保留至少 90 天；未核对 unknown、关联未完成事件及媒体作业保留。不得短于 event 保留期。 |
| failed_media_retention_days | 7 | 失败/不确定媒体快照保存 7 天，过期清理；failed 先冻结为 unknown，禁止缺少原快照后换内容续发。 |
| maintenance_interval_ms | 3600000 | 启动及每小时维护；发送中跳过。 |
| shutdown_timeout_ms | 180000 | 停机最多排空 180 秒；systemd 等待 210 秒。超时退出，下次启动将未确认发送标为 unknown。 |

空间检查是应用预算和提前拒绝，不是文件系统配额；其他进程、日志和备份仍会耗尽磁盘。预留计算偏保守，接近阈值可能提前拒绝。媒体最多四个，图片 20 MiB/视频 50 MiB 是本项目限制，不是已核实的腾讯统一上限。

429、503、507 带 `Retry-After: 5`。先检查 request 状态；只有确认未创建意图，或为安全可续传的 failed，才在修复/等待后用相同 ID 和相同内容重试。客户端断开不会取消已接受的发送。unknown、rejected 不自动重发，不能换 ID 绕过。

维护每轮最多清理 500 个过期事件、500 个发送记录和 500 个媒体作业，并清理超过 24 小时的无引用 outbox 文件。无事件关联的旧版本 muse-* 记录在任意任务未完成时保守保留，排空并核对后才按保留期清理。SQLite 做 WAL checkpoint，删除页供后续复用，数据库文件不一定缩小；文件仍接近预算时，先离线备份并排查未完成任务，再制定扩容/归档方案，不应直接删库。不会无限保留全部历史：超过保留窗口并清理后，旧 ID 可再次被视为新请求，调用方不可永久重用旧 ID，Muse 侧应保留业务去重记录。

```bash
systemctl stop muse-link
muse-link maintain
systemctl start muse-link
```

## 健康与告警

`GET /healthz` 仅表示 HTTP 进程存活。`muse-link health --liveness` 是带认证的存活诊断。`muse-link health` / `GET /v1/health` 检查登录、轮询新鲜度、积压、容量、存储、待核对发送/工具步骤、恢复闸门和旧协议开关，健康时 200，否则 503、CLI 退出 1。启动初期需至少一轮长轮询成功。`require_lease_token=false` 仅为显式兼容旧测试/worker，此时 readiness 报 legacy_worker_protocol，不满足本版上线条件。

hook 先检测待处理数量，唤醒 worker 排空；空闲时检查 readiness，重复故障通知限流。积压告警不能成为禁止处理积压的理由。接收断线指数退避，登录过期停止并要求重新扫码。unknown 核对手机及日志后可记录审阅：

```bash
muse-link review '<request_id>' --reviewed --text - <<'REVIEW'
已核对手机与请求记录，记录观察结果和后续处理决定。
REVIEW
```

此命令仅解除“尚未核对”的告警，状态仍为 unknown，原 ID 永远不会因此自动重发。不得先写 reviewed 再核对。需要结清任务时，在记录业务处置后按当前租约 ack，不以伪造成功回复结清。

通过 systemd journal 保留结构化日志，配置系统日志保留/磁盘限制，监控服务退出、重启频率、CPU/RSS、磁盘剩余和备份年龄。桥自身 metrics 只包含最近 300 个请求，不能当作完整历史或手机送达统计。accepted 只代表腾讯接口确认；timing 不含手机显示延迟。`model_to_submit_ms` 需要真实记录的结果就绪时刻。

## 离线备份和恢复

先暂停 hook、停止服务。备份包含数据库中的会话、上下文和上传密钥、outbox 快照及配置副本，SHA256 manifest 校验完整性但不提供加密或防篡改身份认证。存到加密且限制访问的私密存储，至少每日备份，升级前备份；按业务设定 RPO/RTO。默认建议恢复演练目标 RPO 24 小时、RTO 30 分钟，尚需实际测量。

```bash
stamp="$(date -u +%Y%m%dT%H%M%S)"
muse-link backup --output "$HOME/private-backups/muse-link-$stamp"
muse-link backup verify --from "$HOME/private-backups/muse-link-$stamp"
# 将备份复制到私密离机存储；不在 state_dir 内备份。
```

恢复需要独立 state_dir，校验失败不会替换当前目录。原状态保留为 `.pre-restore-<uuid>`，媒体快照路径按目标目录重定位；配置不自动覆盖，只从备份 config.json 人工核对需要的字段。跨操作系统迁移路径未提供支持。不要恢复不可信来源的备份。

```bash
muse-link restore --from '/private/verified-backup'
```

**恢复后默认暂停轮询、任务领取和新发送。** 旧备份可能缺少已经在微信或外部工具执行的结果，仅靠备份无法排除重放。先核对备份时间后的工具操作、微信已收消息、游标和未完成任务，用私密业务记录补齐/结清；无法核对时保留暂停并报告，不能直接运行 approve。当全部处置记录完毕，服务保持停止状态：

```bash
muse-link restore approve --reviewed --text - <<'RECONCILED'
记录核对范围、工具/微信结果、补齐与结清方式和操作人。
RECONCILED
systemctl start muse-link
muse-link health
```

重新验证后才启用 hook。不要用恢复旧数据库解决单纯的代码回滚；这会扩大已执行动作的重放风险。

## 真实验收与发布门槛

代码测试、Linux 安装模拟和本地 stress 是必要检查，不能替代以下项目。请用 [给 Muse 的生产验收指令](给Muse一键部署的指令.txt)，保留不含凭据的记录：

1. 真实 hook dry_run、启用状态、实际检测间隔、worker 工具权限；微信文字和真实工具调用双向通畅。
2. 图片能在手机打开、视频能播放，记录真实路径、request_id、accepted_at、分阶段耗时和手机观察时间。
3. 同 ID 重复提交不重复收取；实际停机/重启、断网恢复、worker 中途失败、旧租约、未决工具步骤、unknown 都按上述规则处理。模拟 fault 不应触发未授权外部动作。
4. 备份校验、隔离状态恢复、恢复暂停与人工核对、候选版升级和代码回滚演练；记录实际恢复时间。
5. **至少 72 小时真实环境持续运行**，期间有代表性消息、长任务和媒体；没有未处理的错误、重复外部操作或消息丢失，RSS/磁盘没有持续异常增长。记录故障与修复，不能只看最后一次 health。

观测器只读，不发送消息或执行任务；真实流量由用户和 Muse 正常测试产生。从解压的源码目录运行：

```bash
npm ci --omit=dev --no-fund
node scripts/observe.mjs --duration 72h --interval 30s --report "$HOME/private-reports/muse-link-72h.json"
```

报告定期原子保存，Ctrl+C 会标为未完成；任意 unhealthy 采样或中断时退出 1。报告只含状态/数量/耗时，不含 token、正文和账号，但仍应私密保存。它不能证明 hook 工具执行、手机收取或媒体播放；必须与人工验收记录合并。
