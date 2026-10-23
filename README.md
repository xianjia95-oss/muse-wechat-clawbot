# Muse Link

连接 Meta Muse 与微信 ClawBot 的桥接服务，基于 iLink 协议。

支持文字收发、语音转写，以及 Muse 生成的图片和视频回传。暂不支持接收微信图片、视频和文件。

当前部署要求是 [Muse 原生并行](docs/NATIVE_PARALLEL.md)：主代理领取后立即派发独立执行者，继续领取下一条；各执行者完成后直接回微信。不得等待上一条回复后才领取下一条，也不得自动切回单模型串行值守。该要求必须在真实 Muse 主级调度入口接入，安装桥本身不代表已完成接入。

## 快速开始

需要 Node.js 24+，并在微信中启用 ClawBot 插件。

下载[发布包](https://github.com/xianjia95-oss/muse-wechat-clawbot/releases)，解压后执行：

```bash
cd muse-link
npm ci
node src/cli.mjs init
node src/cli.mjs login
npm start
```

登录后，按[部署说明](docs/MUSE.md)配置 Muse hooks，接入任务处理。

main中的rc.7候选源码与GitHub Releases分别更新，下载前核对版本。已有rc.5健康桥可先更新主级调度指令；读新文档或拉取源码不会自动升级后台，不必为调度调整无故重启。

## 文档

- [部署与升级](docs/MUSE.md)
- [API](docs/API.md) · [图片与视频](docs/MEDIA.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [自动唤醒与值守交接](docs/AUTOMATIC_DISPATCH.md) · [给 Muse 的修复指令](docs/给Muse修复自动唤醒的指令.txt)
- [主代理值守与刷新恢复](docs/RUNTIME_RECOVERY.md) · [给 Muse 主代理的执行指令](docs/给Muse修复值守与刷新恢复的指令.txt)
- [Muse 原生任务并行](docs/NATIVE_PARALLEL.md) · [给 Muse 的接入指令](docs/给Muse启用原生并行任务的指令.txt)
- [连续消息与并发队列](docs/BURST_MESSAGES.md) · [给 Muse 的启用指令](docs/给Muse启用并发队列的指令.txt)
- [外部API任务隔离、超时与重试](docs/EXTERNAL_API_TASKS.md)
- [生产部署与验收](docs/PRODUCTION.md) · [微信验收清单](docs/ACCEPTANCE_CHECKLIST.md)
- [rc.6 审计与冒烟报告](docs/AUDIT_v0.4.0-rc.6.md)
- [自动派发排查](docs/AUTOMATIC_DISPATCH.md)
- [主级调度检查](docs/AUTOMATIC_DISPATCH.md)
- [更新日志](CHANGELOG.md)

当前版本：`v0.4.0-rc.7`（预发布） · [MIT License](LICENSE)
