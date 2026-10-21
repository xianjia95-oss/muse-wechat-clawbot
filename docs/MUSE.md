# 在 Meta Muse 云端部署

独立程序 Muse Link v0.3.0，将 Meta Muse 对接微信 ClawBot。需要 Muse 自己的 Linux、Node.js 24+ / npm、运行中的 systemd、服务安装权限和 Muse hooks。文字与图片/视频回传的实际账号收取仍待验证。Muse 使用自身的任务能力处理消息，本项目不调用或替换其模型。

先请用户在微信“我 → 设置 → 插件”确认并启用 ClawBot。部署使用 Muse 自己的云端，不要求额外公网 IP；云实例必须能持续运行桥、访问腾讯 HTTPS 接口并注册平台原生 hooks。

实现参考 [UPGPTs 教程](https://upgpts.com/en/tutorials/muse/muse-wechat) 与其引用的 [腾讯 iLink 协议](https://github.com/tencent/openclaw-weixin/blob/HEAD/docs/protocol_zh_CN.md)。腾讯文档说明该协议描述参考客户端行为，完整服务端契约仍须实测。[接口对照及教程差异](REFERENCE.md) 记录了长轮询、验证码、媒体能力和验收边界。

必须交付两部分：常驻服务接收微信消息并持久化；原生 Muse hook 唤醒具有真实工具权限的任务 worker，再调用 muse reply 直接回传。hook 检测脚本只负责提示新事件，不会自行执行 Muse。教程没有公开 hooks 注册 API，所以必须使用当前 Muse 环境真实提供的协议，不虚构注册成功。

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

## 从 Muse Link v0.2.x 升级

完成已领取的任务或持久化交接进度，暂停现有微信 hook。停止 muse-link 服务后，从 v0.3.0 新解压目录运行安装器，保留原配置、登录和 SQLite 状态，不删除数据库：

```bash
systemctl stop muse-link
bash deploy/install.sh
```

普通用户为 systemctl 加 sudo -n。安装器保留配置，已有配置缺少 media_roots 时默认 ~/workspace；按 [媒体说明](MEDIA.md) 把生成工具实际输出目录合并到配置，再按下方步骤启动服务。更新旧 hook 中的纯文字限制，重新 dry_run 并启用。muse-link status 必须显示 version=0.3.0、capabilities.send 含 image/video，不能只根据新 CLI 的版本判断后台升级成功。已有会话健康时无需重新扫码。可直接使用 [升级指令](给Muse升级的指令.txt)。

## 扫码

没有可用会话时执行：

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

源代码运行时把命令改为 `node src/cli.mjs login verify ...`。正文仅能为数字，上述文字占位符必须替换。验证码从标准输入传入，不放进命令参数；命令只输出 submitted=true，不代表已登录。等待原登录日志 logged_in=true；若再次 verification_required，使用新的 code_file 并请用户核对手机。临时文件在读取、取消或超时后删除，验证码不写入会话数据库。verification_blocked 表示微信阻止继续尝试，停止并稍后重新扫码；already_bound 不代表拿到了新凭证，应检查原服务健康。

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

## 注册 hook 和完整唤醒指令

脚本 `~/hooks/scripts/muse-link-wechat.sh`，建议 poll_interval_secs=5，以实际平台支持为准并记录生效值。Muse 必须把 wake/silent 输出适配成平台实际协议，先 dry_run 再 enable；dry_run 不得 pull。记录真实 hook 标识、启用状态、检测间隔和 worker 工具权限。更新或替换旧 hook，不要两套同时运行。把下面全部写入新 hook 的任务指令：

1. 原因为“Muse 微信桥异常”：检查 muse-link status、health 和 systemd 日志，在 Muse 聊天用中文报告原因和建议。不要擅自启动可能被用户主动停止的服务。
2. 原因为“微信有 N 条新事件”：`muse-link muse next --lease 30m`，读取 tasks，按 event_id 去重，持久化任务进度。若 completion.state=unknown/rejected，不得重新执行整个任务或换 ID 发送；先根据 completion.result 核对并报告。failed 且 retryable=true 表示文件准备或上传失败，按原任务进度修复原因，再用原文字和媒体路径续传，跳过已确认消息，不重做生成任务。
3. kind=alert：在 Muse 聊天报告 alert.message，不回微信，然后 `muse-link muse ack '<event_id>'`。
4. 普通事件读取 text、voice_text；需要工具的请求必须交由真实 Muse worker 调用所需工具，不能以固定回复或概述冒充执行。media_errors 非空必须说明附件暂不支持，请用户直接在 Muse 提供，不能声称已读取。三者都为空的事件忽略后 ack。
5. **回复准备好后，下一步立即执行发送，再写 Muse 内的完成说明。** 不要只在 Muse 聊天写结果，等另一轮 hook 或定时任务转发。
6. 使用事件编号，桥自动选择微信收件人和固定的最终回复编号，重试时文字及媒体类型/路径必须一致。纯文字示例：

   ```bash
   muse-link muse reply '<event_id>' --text - <<'MUSE_REPLY'
   回复正文
   MUSE_REPLY
   ```

   换成事件真实值。heredoc 分隔符加引号，选不会出现在正文中的值。不要把用户文本拼成 shell 代码。长任务先用同一 reply 命令加 `--progress --reply-id started` 发简短确认，进度回复不会结束任务；每条不同的进度要用稳定且不同的 reply-id。租约可提高到 1 小时并持久化进度。

   需要回传生成图片/视频时，先用真实 Muse 工具生成原文件，导出到 config.media_roots 允许目录，再在同一最终 reply 加 `--image '/absolute/result.png'` 或 `--video '/absolute/result.mp4'`。最多 4 个媒体，可省略文字；图片 20 MiB、视频 50 MiB，本包不转码。可在最终命令同时传所有媒体和文字，不能先最终回复文字结束事件再补图。进度预览也可带 --progress --reply-id preview。只有 URL 或内部媒体 ID 时，先导出文件，不能把链接作为路径。详见 [媒体说明](MEDIA.md)。

7. state=accepted 代表微信接口确认，不代表手机已显示或视频能播放。调用中断先 `muse-link request '<request_id>'` 核对。unknown、rejected 或部分成功在 Muse 聊天报告，不能换新 ID 盲目重发。failed、retryable=true 可用原请求显式续传；持续失败时报告并保留任务，不无限循环。需要用户决定的重发先说明已成功消息数和不确定部分。
8. 能准确记录任务结果就绪时间时，可附 `--ready-at '<ISO 时间>'`，否则省略，不能把工具调用时间冒充生成时间。
9. 最终 reply 成功后程序自动 ack；不需再手动确认。忽略空事件、无需回复或已向用户报告并持久化交接的失败，用 `muse-link muse ack '<event_id>'` 确认。未完成不提前 ack；租约过期会重投，恢复时检查去重记录。程序会自动清理已经成功发完最终回复、但上次来不及 ack 的事件。

## 验收

请用户先从微信向 ClawBot 发一句短消息。Muse 回复后核对手机是否收到，保存 event_id、request_id 和 timing，查看 muse-link metrics。

再从微信发“请实际调用 shell 获取当前 UTC 时间和 Node.js 版本，把结果回微信”。检查真实 worker 工具调用记录，确认执行结果已回到手机；简单问候或假 worker 不能作为此项通过。记录事件 received_at、worker 启动时间、真实结果就绪时间（可获得时）、发送返回的 accepted_at 和手机收取情况。最后核对长回复、服务重启、相同 ID 重试。

再测试实际生成的小图片与短 MP4 回传，记录真实文件路径、media_upload_ms、send_message_ms，核对手机可打开图片、播放视频。更换旧 hook 的“只能回文字”指令后仍需此项验证；本地视频协议测试没有验证手机播放。

timing 测量桥处理与微信 API 确认，不测手机显示时间。Muse 完成后很久才收到时，先比较 model_to_submit_ms 与 upstream_ms，再核对手机显示时间；不要把 35 秒长轮询当成发送的固定等待。比较旧方案须在相同云端、代理和相近内容长度下实测。本地模拟结果不能当作微信速度。
