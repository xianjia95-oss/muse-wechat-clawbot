# Muse Link：Muse 微信桥

连接 Meta Muse 与微信 ClawBot。仓库提供三个独立版本的项目源码、安装包和部署指令，每次选择一个版本部署。

| 版本 | 工作方式 | 完整部署指令 | 安装包 |
| --- | --- | --- | --- |
| [v0.3.0](versions/v0.3.0) | 原版常驻 worker，直接领取并回复 | [一键部署](guides/v0.3.0-一键部署.txt) | [下载 ZIP](https://github.com/xianjia95-oss/muse-wechat-clawbot/raw/refs/heads/main/packages/muse-link-v0.3.0.zip) |
| [v0.4.0-rc.5](versions/v0.4.0-rc.5) | 常驻 worker，最多两个本地后台工具 job，支持入站多媒体 | [一键部署](guides/rc.5-一键部署.txt) | [下载 ZIP](https://github.com/xianjia95-oss/muse-wechat-clawbot/raw/refs/heads/main/packages/muse-link-v0.4.0-rc.5-clean-install.zip) |
| [v0.4.0-rc.7 负责人版](versions/v0.4.0-rc.7-owner) | 一个负责人统一回复，两个真实 Muse 草稿执行者处理文字任务 | [一键部署](guides/rc.7-负责人一键部署.txt) | [下载 ZIP](https://github.com/xianjia95-oss/muse-wechat-clawbot/raw/refs/heads/main/packages/muse-link-v0.4.0-rc.7-owner.zip) |

[SHA256SUMS.txt](SHA256SUMS.txt) 提供当前安装包校验值，[versions.json](versions.json) 记录包路径、版本与构建标识。使用完整指令开头的 SHA256 核对匹配 ZIP。

## 一键部署

把选定版本的 ZIP 和对应完整部署指令一起上传到 **Muse 主聊天**，让主代理完整执行。流程包含环境准备、安装、扫码后启动服务、创建真实常驻角色、hook 和定时巡检恢复。用户完成必要扫码与平台授权；单独安装 Node 服务不会产生能回答消息的 Muse worker。

Muse Linux 环境需要 Node.js 24+、npm、运行中的 systemd 及服务安装权限，无需开放入站端口。已有健康部署保留登录、配置、SQLite 与任务交接，先按 [安装与升级](INSTALL.md) 操作。

新环境也可使用下列入口安装 rc.5：

```bash
setup_file="$(mktemp)" &&
curl -fsSL --connect-timeout 10 --max-time 60 \
  https://raw.githubusercontent.com/xianjia95-oss/muse-wechat-clawbot/main/deploy/bootstrap.sh \
  --output "$setup_file" &&
bash "$setup_file" --version v0.4.0-rc.5 --install-only \
  --require-build rc5-inbound-media-20261028 \
  --require-recovery rc5-recovery-20261029-patrol1
```

安装后由 Muse 主代理继续执行 [rc.5 完整部署指令](guides/rc.5-一键部署.txt)。另两版分别使用 `--version v0.3.0` 或 `--version v0.4.0-rc.7-owner`。不要同时运行同一账号的多个桥实例。

## 版本能力

- **v0.3.0**：常驻直接消费；单 worker 长任务会排队。可回传图片和视频，入站以文字和微信已有语音转写为主。
- **rc.5**：下载并解密微信图片、视频和原始语音，SILK/PCM 尝试转为 WAV；Muse 使用真实媒体工具读取文件。支持图片、视频回传，不支持普通文件或语音回传。多媒体构建号为 `rc5-inbound-media-20261028`，恢复工具修订为 `rc5-recovery-20261029-patrol1`。
- **rc.7 负责人版**：只有负责人向微信回复，两个草稿执行者使用真实 handle 绑定独立槽位，持续处理文字任务。按负责人部署指令选择模式。

桥传递消息和附件；Muse 的理解与生成能力由实际原生工具决定。`accepted` 表示微信接口接受，手机显示和播放以实际使用为准。

rc.5 的源码和 ZIP 均包含 [桥恢复入口](versions/v0.4.0-rc.5/docs/RUNTIME_RECOVERY.md) 与 [只读 HTTP 后台工具](versions/v0.4.0-rc.5/docs/BURST_MESSAGES.md)。恢复入口自带全过程锁、维护保护、失败退避及未决意图保护，自动启动默认关闭，由主聊天按用户授权设置私密策略；无需复制个人环境脚本或运行凭据。

## 常驻与环境恢复

三版均由主聊天创建常驻角色并登记定时巡检。巡检通过正式平台入口自动通知原主聊天，主聊天核实原生任务后补位。桥重启、原生角色接班和整个环境刷新恢复分别核对；只有计划已登记不能证明自动恢复可用。各版完整部署指令包含具体处理规则。

项目采用 [MIT License](LICENSE)。各版本的依赖许可见 `THIRD-PARTY.md` 与 `LICENSE.tencent`。
