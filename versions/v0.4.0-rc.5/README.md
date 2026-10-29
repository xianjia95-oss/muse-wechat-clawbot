# Muse Link v0.4.0-rc.5

Meta Muse 与微信 ClawBot 的常驻桥，包含入站多媒体构建 `rc5-inbound-media-20261028` 与恢复工具修订 `rc5-recovery-20261029-patrol1`。

## 部署

把本版安装 ZIP 与 [给 Muse 一键部署的指令](docs/给Muse一键部署的指令.txt) 一起交给 Muse 主聊天。需要 Linux、Node.js 24+、npm、运行中的 systemd 及服务安装权限。

手动安装时，在本目录运行：

```bash
bash deploy/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

按 [Muse 部署说明](docs/MUSE.md) 继续扫码登录、启动桥、创建真实常驻 worker、接入 hook 和定时巡检。扫码后继续执行，不能停在桥安装完成。已有健康部署保留配置、登录、数据库和原任务。

## 功能

- 文字任务、原子领取、租约续期、进度/最终回复、自动确认与发送去重。
- 微信图片、视频、原始语音后台下载解密并私密交接；SILK/PCM 尝试转换 WAV。Muse 必须使用实际媒体工具打开文件。
- 支持图片、视频回传，不提供普通文件处理或语音回传。
- 常驻 worker 可使用最多两个本地后台工具 job；本地工具并发不等于 Muse 原生推理全并行。
- 自带持锁桥恢复入口 `deploy/recover-service.sh` 与有界只读 HTTP 工具 `scripts/http-tool.mjs`，随源码和安装包分发。自动启动需私密策略明确授权；不会自动创建 Muse 原生任务或绕过域名授权。
- hook 与巡检共用 `deploy/patrol.sh`，通过本地 API 检查、私密保留脱敏故障证据并去重。健康与重复轮次静默，通知须按结构化结果接入平台完成回调；不把 wake 当已送达。

运行中的 `status` 应包含匹配 version/build，`health` 应正常。环境刷新、缺服务单元与 worker 补位按 [运行恢复](docs/RUNTIME_RECOVERY.md) 和 [完善巡检指令](docs/给Muse完善巡检的指令.txt) 执行。

接口见 [API](docs/API.md)，媒体规则见 [MEDIA](docs/MEDIA.md)，维护与备份见 [PRODUCTION](docs/PRODUCTION.md)。采用 MIT 许可证，第三方许可见 [THIRD-PARTY.md](THIRD-PARTY.md)。
