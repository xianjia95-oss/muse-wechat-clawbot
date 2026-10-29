# 从零部署 Muse Link

目标是在微信 ClawBot 里向 Meta Muse 发任务，由 Muse 回复。无需额外公网 IP、域名或入站端口。本项目使用 Muse 自身任务能力，不需要另填模型 API Key。

部署包含安装微信桥、扫码登录、启动一个负责人及两个真实草稿执行者。**桥安装成功不代表有人处理消息**，须核对三个角色并用手机验证。使用三版本目录中 rc.7 负责人包及匹配 SHA256；历史同版本号 Release 不一定包含相同接口，不混用来源。

## 1. 准备条件

| 条件 | 怎么确认 |
| --- | --- |
| 微信账号支持 ClawBot | 在微信「我 → 设置 → 插件」查看，以账号实际可见入口为准。 |
| Muse 自己的 Linux 云端 | 安装器需要 Linux 和运行中的系统 systemd；未启用 systemd 的普通容器不符合要求。 |
| Node.js 24+ 与 npm | 检查 `node -v`、`npm -v`；缺失先按 [Node.js 官方说明](https://nodejs.org/en/download)配置。安装器不自行替换系统 Node。 |
| 服务安装权限 | 以 Muse HOME 属主运行；非 root 用户需能用 `sudo -n`，不要 `sudo bash` 整个脚本。 |
| 网络和持久化本地磁盘 | 能访问 GitHub、npm 和腾讯 iLink HTTPS 接口；配置与 SQLite 持久化，无需开放 18791 到公网。 |
| 真实原生任务能力 | Muse 主代理能创建、查询原生任务，worker 能运行 CLI；缺少时只能装桥，不能完成自动对话。 |

已经安装过请直接看本文「已有安装」，不要为了这份教程重启健康服务、重新扫码或删除状态。

## 2. 推荐：复制给 Muse

把下面整段发到 **Meta Muse 主聊天**，不要交给不能创建任务的普通子代理：

```text
请在你自己的 Linux 云端部署 Muse Link，把你接入我的微信 ClawBot。
项目：https://github.com/xianjia95-oss/muse-wechat-clawbot
请读取 main 分支 versions/v0.4.0-rc.7-owner/docs/给Muse一键部署的指令.txt，按完整流程执行。
已有安装保留在线桥、登录、SQLite 和原任务，先核对原任务，按配套指令安全交接。
首次安装使用 deploy/bootstrap.sh，立即把当前扫码 PNG 展示给我；
登录后启动桥，接入一个固定常驻负责人和两个真实常驻文字草稿执行者，持续轮询。
最后请我只从微信发消息，验证能自动处理并回复。
逐项报告通过、失败或未执行，不上传配置、二维码和调试资料。
```

完整执行文件：[给 Muse 一键部署的指令](给Muse一键部署的指令.txt)。

## 3. 自己执行终端命令

在 **Muse Linux 云端**运行，下载成功才执行，不需要 Git 或 Python：

```bash
setup_file="$(mktemp)" &&
curl -fsSL --connect-timeout 10 --max-time 60 \
  https://raw.githubusercontent.com/xianjia95-oss/muse-wechat-clawbot/main/deploy/bootstrap.sh \
  -o "$setup_file" && bash "$setup_file" --version v0.4.0-rc.7-owner
```

脚本检查环境，解析 `main` 的完整 commit，按该 commit 下载源码，安装锁定依赖、私密配置和 systemd 服务，然后后台启动登录。安装提交保存在 `~/.local/share/muse-link/current/source-commit.txt`。这是 `main` 候选源码，与 Releases 旧包不同，不代表候选版已通过云端验收。

日志和状态放在每次独立的私密目录：

```text
~/.local/state/muse-link-setup/attempt.XXXXXXXX/setup.log
~/.local/state/muse-link-setup/attempt.XXXXXXXX/state.json
```

**以脚本实际输出的路径为准**，不要照抄 `XXXXXXXX`。让 Muse 立即读 `setup.log`，不要等后台登录结束才显示二维码。刚提交时 state.json 可能还没生成；PID 文件本身不证明流程仍在运行。

只安装、不扫码也不启动服务：

```bash
bash "$setup_file" --version v0.4.0-rc.7-owner --install-only
```

固定安装提交时，在上述显式版本命令增加 `--ref '<tag或完整commit>'`，将占位符换为实际值。所选源码必须包含本教程和对应安装流程，旧标签不支持时明确退出。手动解压、升级及回滚见 [详细部署说明](MUSE.md)。依赖安装仍需连接 npm。

## 4. 扫码与配对验证码

日志出现 `event=qr` 时，Muse 立即展示该记录 `file` 指向的**原始 PNG**。用手机微信扫描、确认，可在另一块屏幕查看图片。二维码会刷新，必须看最新记录，旧截图不能保证有效。

手机显示配对数字时，日志为 `event=verification_required`。把手机实际数字告诉 Muse，保留前导零；Muse 按 [配对流程](MUSE.md#手机要求配对验证码时)从标准输入提交，不写进命令参数。`submitted=true` 只表示提交，须等原日志 `logged_in=true`。

登录最多等待 10 分钟。超时或明确失败后，先确认旧登录已结束，再重新发起：

```bash
bash "$HOME/.local/share/muse-link/current/deploy/activate.sh"
```

它打印新的私密日志路径，并发登录会被锁拒绝。**原日志已经登录成功但服务启动失败时，应修复服务，不要重新扫码。** 在线服务不会被这条命令重启。

登录成功后，后台才执行 `systemctl enable --now muse-link.service` 并检查 readiness。查看 `state.json`：

| stage | 含义与下一步 |
| --- | --- |
| `waiting_for_scan` | 读取日志，展示二维码或处理配对数字。 |
| `starting_bridge` | 已登录，正在启动和检查桥。 |
| `bridge_ready` | 桥通过当前健康检查，继续接入固定对话负责人。 |
| `bridge_already_running` | 桥已在线，未重登/重启，核对现有服务和 worker。 |
| `bridge_started_check_needed` | 已请求启动但未确认 readiness，查看同目录 health.json/health.stderr 与系统日志。 |
| `failed` | 查看 exit_code 和日志，不要报告部署完成。 |

## 5. 接入固定对话负责人

桥健康后，由 **Muse主代理**执行 [统一对话切换指令](给Muse切换统一对话与后台任务的指令.txt)，读取 [完整协议](CONVERSATION_OWNER.md)。负责人持续直接领取，使用私密session文件；每条先读上下文，再判断立即回答或交后台执行，不逐条等hook唤醒。

耗时工具最多2项活动、CPU密集最多1项；执行者只返回结果。原生图像/视频权限及异步入口必须在当前角色实际核实，没有就标未接入。不要创建六个随机消费者来代替会话连续性，也不能单个负责人同步等待所有长工具。

本负责人包另支持[图片、视频与语音双向传递](MEDIA.md)：入站附件自动下载解密、用原任务凭据查询ready文件，Muse须有真实读取工具才能理解。下载中负责人继续处理文字；文字草稿邮箱不接媒体。回传语音可用--voice发送已生成的单声道PCM16 WAV，不内置语音识别或合成。以三版本目录匹配源码与包 SHA 为准，不从旧同版本号包认定能力。

复杂文字的推理并行须再按[MUSE_EXECUTORS.md](MUSE_EXECUTORS.md)预先启动两个真实原生执行者并让其持续领取草稿，只有负责人回复微信。`next --with-context`减少普通消息读取上下文的一次往返；每次领取一条不要求前一条完成。不能仅把六个消费者减成一个就报告并行优化完成。

已有旧部署先交接、备份并安装配套候选代码；旧消费者停止新next并安全收尾，session start须有效租约与发送归零，不清租约、不丢原交接。只读hook仍用于检测/告警与恢复提示，不能拿wake证明恢复通过。

## 6. 用微信验收

接入后停止人工操作主聊天，只从微信 ClawBot 发送：

1. 一条简单问候，核对手机收到回复。
2. 「请实际运行 shell，获取当前 UTC 时间和 Node.js 版本，把结果回微信。」核对真实工具记录与手机结果。
3. 一分钟内 10 条不同编号的独立短任务，核对不缺失、不重复、不串回复，记录领取、accepted 及手机时间。
4. 另一个任务进行 90 秒无副作用等待时，再发独立短任务，确认能先于长任务收到回复。

用户必须进入主聊天手动救援才能回复，自动消费验收就未通过；主聊天经真实平台通知自动执行恢复，应按触发记录另行核验。accepted 仅为腾讯接口确认，手机显示仍须用户核对。安装器不能保证固定回复秒数，完整清单见 [验收说明](给Muse一键部署的指令.txt)。

## 已有安装

一键首次安装入口发现已有服务、安装目录、配置或数据库会退出，不自动升级。先只读检查：

```bash
"$HOME/.local/bin/muse-link" status
"$HOME/.local/bin/muse-link" health
"$HOME/.local/bin/muse-link" diagnose
```

健康桥没人回复时先核对对话负责人，按第5步安全恢复，不重复安装或更换登录。确需升级按 [MUSE.md](MUSE.md) 和 [生产运维](PRODUCTION.md)先交接、停服、备份再装。健康rc.5可继续原协议；新会话功能须配套升级，不能仅换提示词。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 缺 Node 或版本低 | 在 Muse 云端配置 Node.js 24+ 与 npm 后重试，本机安装不会改变云端。 |
| 缺 systemd / 服务权限 | 当前环境不符合一键入口要求。选择有权限且运行系统 systemd 的 Muse Linux 环境；开发运行见 MUSE.md。 |
| GitHub/npm 下载失败 | 查原错误、修复当前网络或合法 HTTP/HTTPS 代理，不因此尝试用户其他 API 或扩大业务域名授权。 |
| 已有安装或中途安装失败 | 保留配置/状态，检查具体失败阶段，按 MUSE.md 从完整源码恢复安装；不要删除 SQLite 来绕过预检。 |
| 扫码过期或没有图片 | 核对进程、最新 event=qr 和真实 PNG，超时再新起一轮，不复用旧图。 |
| 已登录但没启动 | 查 setup.log、`systemctl status muse-link`、`journalctl -u muse-link -n 80 --no-pager`；修复后 root 执行 `systemctl enable --now muse-link.service`，普通用户加 `sudo -n`，不重复扫码。 |
| healthy 但不回复 | 核对真实常驻任务和 diagnose，区分 ready 无人领、leased 未完成和发送失败。 |
| 只有第一次能回复 | worker 可能是单轮探针，按完整常驻协议持续 next/reply，空队列继续等。 |
| 长任务/授权等待拖慢其他消息 | 核对负责人是否同步等待工具或触发授权、后台是否可独立查询；不在主循环无限重试，平台授权仍须在原平台处理。 |
| 环境刷新后不回复 | 刷新会杀死进程/任务，按 [运行恢复](RUNTIME_RECOVERY.md)核对重建。systemd 自启不等于平台刷新或原生任务自动恢复已通过。 |

配置、数据库、验证码、二维码和日志仅留本地私密目录，不提交 GitHub。反馈仅提供脱敏错误与状态，见 [故障排查](TROUBLESHOOTING.md)。
