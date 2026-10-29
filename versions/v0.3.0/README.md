# Muse Link v0.3.0

Meta Muse 与微信 ClawBot 的原版常驻桥。worker 持续领取消息、实际处理并回复，完成一条后立即继续领取。

## 部署

把本版安装 ZIP 与 [给 Muse 一键部署的指令](docs/给Muse一键部署的指令.txt) 一起交给 Muse 主聊天。运行环境需要 Linux、Node.js 24+、npm、systemd 和服务安装权限。

手动安装时，在本目录运行：

```bash
bash deploy/install.sh
export PATH="$HOME/.local/bin:$PATH"
cp -R docs deploy "$HOME/.local/share/muse-link/"
```

随后按 [Muse 部署说明](docs/MUSE.md) 完成扫码、启动服务、创建真实常驻 worker 以及 hook/定时巡检。用户完成扫码或授权；已有有效登录时复用。

## 功能

- 文字收发、任务路由、进度回复、成功后自动确认和重复发送去重。
- Muse 可向微信发送本地图片和视频；入站以文字及微信已有语音转写为主。
- 单 worker 逐条处理，长任务会让后续消息等待。本版没有新版 lease token、renew 或后台工具队列。

环境刷新后的桥和 worker 按 [完整部署指令中的常驻与巡检规则](docs/给Muse一键部署的指令.txt) 处理。不要清库或删除有效任务来强行接管；主聊天核实真实任务后按需补位。

接口见 [API](docs/API.md)，媒体规则见 [MEDIA](docs/MEDIA.md)。采用 MIT 许可证，第三方许可见 [THIRD-PARTY.md](THIRD-PARTY.md)。
