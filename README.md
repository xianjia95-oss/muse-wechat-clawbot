# Muse Link

连接 Meta Muse 与微信 ClawBot 的桥接服务，基于 iLink 协议。

支持文字收发、语音转写，以及 Muse 生成的图片和视频回传。暂不支持接收微信图片、视频和文件。

当前部署采用 [常驻 Muse worker 池](docs/NATIVE_PARALLEL.md)：主代理默认维护 6 个真实原生 worker，各自直接领取、处理并回微信，空闲后继续领取，不再每条消息等 hook 唤醒主代理。独立任务完成即回复；所有 worker 忙时仍会排队。安装桥本身不会创建 Muse 任务，原生池仍须在部署环境接入及验收。

## 新手部署：复制给 Muse

先在微信中确认账号可以使用 ClawBot，然后把下面这段发送给 **Meta Muse 主代理**：

```text
请在你自己的 Linux 云端部署 Muse Link，把你接入我的微信 ClawBot。
项目：https://github.com/xianjia95-oss/muse-wechat-clawbot
请读取 main 分支 docs/给Muse一键部署的指令.txt，按完整流程执行。
先检查环境；已有安装时保留服务、登录和状态，不重复安装。
首次安装使用 deploy/bootstrap.sh，立即向我展示当前扫码图片；
登录后启动桥，再创建或补齐 6 个真实常驻 Muse worker，最后让我从微信验收。
不要只安装桥就报告全部完成，也不要上传配置、二维码、聊天或调试记录。
```

详细步骤见 **[新手部署教程](docs/QUICKSTART.md)**，包括环境要求、扫码、配对验证码、6 个 worker、手机验收和常见问题。

### 一条命令安装微信桥

在 **Muse 的 Linux 云端终端**运行。需要 Node.js 24+、npm、运行中的 systemd 及服务安装权限；不要在 Windows PowerShell 运行，也不要给整个脚本加 sudo。

```bash
setup_file="$(mktemp)" &&
curl -fsSL --connect-timeout 10 --max-time 60 \
  https://raw.githubusercontent.com/xianjia95-oss/muse-wechat-clawbot/main/deploy/bootstrap.sh \
  -o "$setup_file" && bash "$setup_file"
```

脚本下载并安装固定提交的源码，后台启动扫码，登录成功后启动桥。**让 Muse 立即读取脚本输出的私密日志并展示当前二维码**；配对验证码按教程提交。它不会创建原生 Muse 任务，仍需 Muse 执行[常驻 worker 指令](docs/给Muse恢复常驻worker的指令.txt)。已有安装会直接退出，不覆盖在线服务。

该入口默认安装 `main` 候选源码，不代表 Releases 已发布或真实验收通过。只安装不登录/不启动可用 `bash "$setup_file" --install-only`；固定版本或提交可加 `--ref <tag或完整commit>`，所选源码须包含新安装流程。手动解压部署和升级见[详细说明](docs/MUSE.md)。

候选源码与 GitHub Releases 分别更新，下载前核对版本。已有健康 rc.5 桥可先按 [恢复常驻 worker 指令](docs/给Muse恢复常驻worker的指令.txt) 调整值守，不为此无故升级或重启。文件仍在不代表刷新后的任务存活；自动恢复须另行验收。

## 文档

- **[新手部署教程与一键安装](docs/QUICKSTART.md)** · [给 Muse 的完整部署指令](docs/给Muse一键部署的指令.txt)
- [部署与升级](docs/MUSE.md)
- [API](docs/API.md) · [图片与视频](docs/MEDIA.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [自动唤醒与值守交接](docs/AUTOMATIC_DISPATCH.md) · [给 Muse 的修复指令](docs/给Muse修复自动唤醒的指令.txt)
- [常驻池与刷新恢复](docs/RUNTIME_RECOVERY.md) · [给 Muse 主代理的执行指令](docs/给Muse修复值守与刷新恢复的指令.txt)
- [恢复常驻 worker](docs/给Muse恢复常驻worker的指令.txt)
- [Muse 原生任务并行](docs/NATIVE_PARALLEL.md) · [给 Muse 的接入指令](docs/给Muse启用原生并行任务的指令.txt)
- [连续消息与并发队列](docs/BURST_MESSAGES.md) · [给 Muse 的启用指令](docs/给Muse启用并发队列的指令.txt)
- [外部API任务隔离、超时与重试](docs/EXTERNAL_API_TASKS.md)
- [生产部署与验收](docs/PRODUCTION.md) · [微信验收清单](docs/ACCEPTANCE_CHECKLIST.md)
- [rc.6 审计与冒烟报告](docs/AUDIT_v0.4.0-rc.6.md)
- [消息延迟与未回复的排查](docs/INCIDENT_RESPONSE.md)
- [常驻池检查](docs/DISPATCH_REVIEW.md)
- [更新日志](CHANGELOG.md)

当前版本：`v0.4.0-rc.7`（预发布） · [MIT License](LICENSE)
