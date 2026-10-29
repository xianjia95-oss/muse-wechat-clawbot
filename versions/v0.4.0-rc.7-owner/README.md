# Muse Link v0.4.0-rc.7 负责人版

一个常驻负责人统一接收和回复微信，两个真实 Muse 草稿执行者持续处理文字任务；负责人不必等待前一条草稿完成才继续领取。

## 部署

把本版安装 ZIP 与 [给 Muse 一键部署的指令](docs/给Muse一键部署的指令.txt) 一起交给 Muse 主聊天。需要 Linux、Node.js 24+、npm、运行中的 systemd 和服务安装权限。

手动安装时，在本目录运行：

```bash
bash deploy/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

按 [从零部署](docs/QUICKSTART.md) 或 [Muse 部署说明](docs/MUSE.md) 完成登录、启动桥，再由主聊天创建负责人及两个真实执行者。分别用各自完整真实 handle 绑定独立 slot，核对运行状态后才开始分派。

## 工作方式

- 负责人持续领取、维护上下文、提交草稿任务并统一回复；草稿执行者不直接领取微信消息或向微信回复。
- 两个执行者持续轮询私密邮箱，完成一条后继续消费；任一角色不能因队列空或阶段报告而退出。
- 支持文字历史、租约及未决步骤保护、后台工具与媒体收发。两个草稿槽忙时复杂任务可能排队。
- 图片、视频和语音由桥传递文件，实际理解和生成由 Muse 的原生工具完成。

角色与槽位规则见 [CONVERSATION_OWNER](docs/CONVERSATION_OWNER.md) 和 [MUSE_EXECUTORS](docs/MUSE_EXECUTORS.md)。环境刷新、主聊天巡检与自动补位见 [RUNTIME_RECOVERY](docs/RUNTIME_RECOVERY.md)，缺少真实平台入口时不能声称自动恢复成功。

已有部署按配套说明交接，保留登录、数据库和原任务，不直接套用旧多 worker 消费模式。接口见 [API](docs/API.md)，媒体规则见 [MEDIA](docs/MEDIA.md)。采用 MIT 许可证，第三方许可见 [THIRD-PARTY.md](THIRD-PARTY.md)。
