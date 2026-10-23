# 从零部署 Muse Link

目标是在微信 ClawBot 里向 Meta Muse 发任务，由 Muse 回复。无需额外公网 IP、域名或入站端口。本项目使用 Muse 自身任务能力，不需要另填模型 API Key。

部署包含安装微信桥、扫码登录、启动真实常驻 Muse worker 三部分。**桥安装成功不代表有人处理消息**，必须建好 worker 池并用手机验证。

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
请读取 main 分支 docs/给Muse一键部署的指令.txt，按完整流程执行。
已有安装保留在线桥、登录、SQLite 和原任务，只补缺失的健康 worker。
首次安装使用 deploy/bootstrap.sh，立即把当前扫码 PNG 展示给我；
登录后启动桥，用真实原生任务工具创建或补齐 6 个常驻 worker。
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
  -o "$setup_file" && bash "$setup_file"
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
bash "$setup_file" --install-only
```

固定安装版本或提交，可改用 `bash "$setup_file" --ref '<tag或完整commit>' --install-only`，将占位符换为实际值。所选源码必须包含本教程和新安装流程，旧标签不支持时明确退出。手动解压、升级及回滚见 [详细部署说明](MUSE.md)。依赖安装仍需连接 npm。

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
| `bridge_ready` | 桥通过当前健康检查，继续建 Muse worker 池。 |
| `bridge_already_running` | 桥已在线，未重登/重启，核对现有服务和 worker。 |
| `bridge_started_check_needed` | 已请求启动但未确认 readiness，查看同目录 health.json/health.stderr 与系统日志。 |
| `failed` | 查看 exit_code 和日志，不要报告部署完成。 |

## 5. 建立 6 个常驻 Muse worker

桥健康后，由 **Muse 主代理**完整执行 [常驻 worker 指令](给Muse恢复常驻worker的指令.txt)。安装后的文件位置：

```text
~/.local/share/muse-link/current/docs/给Muse恢复常驻worker的指令.txt
```

主代理使用真实平台工具建立 **6 个不同的原生常驻任务**，核对真实 handle、运行状态和工具权限。已有 3 个健康者保留，只补 3 个；不能用 Node/shell 进程冒充 Muse worker。

各 worker 自己循环领取、处理、回复，再领取。独立任务谁完成谁先回，6 个全忙时后续仍排队，任一空闲就补位。本地 CPU 密集工具共享活动名额仍为 1；实际平台资源和额度须在云端确认。

hook 按 [Muse 部署说明](MUSE.md#注册-hook-与常驻-worker-协议)注册、dry_run、启用，只做只读检测、告警和补位提示。日常消息由常驻 worker 领取，不逐条等 hook 唤醒。只有 wake 或 healthy=true 不能证明消费者活着。

## 6. 用微信验收

建池后停止人工操作主聊天，只从微信 ClawBot 发送：

1. 一条简单问候，核对手机收到回复。
2. 「请实际运行 shell，获取当前 UTC 时间和 Node.js 版本，把结果回微信。」核对真实工具记录与手机结果。
3. 一分钟内 10 条不同编号的独立短任务，核对不缺失、不重复、不串回复，记录领取、accepted 及手机时间。
4. 另一个任务进行 90 秒无副作用等待时，再发独立短任务，确认能先于长任务收到回复。

必须进入主聊天人工领取/派发才能回复，自动消费验收就未通过。accepted 仅为腾讯接口确认，手机显示仍须用户核对。安装器不能保证固定回复秒数，完整清单见 [验收说明](ACCEPTANCE_CHECKLIST.md)。

## 已有安装

一键首次安装入口发现已有服务、安装目录、配置或数据库会退出，不自动升级。先只读检查：

```bash
"$HOME/.local/bin/muse-link" status
"$HOME/.local/bin/muse-link" health
"$HOME/.local/bin/muse-link" diagnose
```

健康桥没人回复时先核对 worker，按第 5 步补齐，不重复安装或更换登录。确需升级按 [MUSE.md](MUSE.md) 和 [生产运维](PRODUCTION.md)先交接、停服、备份再装。健康 rc.5 桥可先恢复常驻池，无须为此升级。

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
| 长任务/授权等待拖慢其他消息 | 核对是否有独立空闲 worker、共享资源是否阻塞；不在主循环无限重试，平台授权仍须在原平台处理。 |
| 环境刷新后不回复 | 刷新会杀死进程/任务，按 [运行恢复](RUNTIME_RECOVERY.md)核对重建。systemd 自启不等于平台刷新或原生任务自动恢复已通过。 |

配置、数据库、验证码、二维码和日志仅留本地私密目录，不提交 GitHub。反馈仅提供脱敏错误与状态，见 [故障排查](TROUBLESHOOTING.md)。
