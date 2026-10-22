# Muse Link

连接 Meta Muse 与微信 ClawBot 的桥接服务，基于 iLink 协议。

支持文字收发、语音转写，以及 Muse 生成的图片和视频回传。暂不支持接收微信图片、视频和文件。

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

## 文档

- [部署与升级](docs/MUSE.md)
- [API](docs/API.md) · [图片与视频](docs/MEDIA.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [生产部署与验收](docs/PRODUCTION.md)
- [更新日志](CHANGELOG.md)

当前版本：`v0.4.0-rc.5`（预发布） · [MIT License](LICENSE)
