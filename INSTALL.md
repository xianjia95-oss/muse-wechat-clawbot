# 安装与升级

本仓库保存三个独立版本。每次选择一个版本部署到 Muse Linux 云端；三份源码同时存在不代表三个服务同时运行。

首次部署将选定版本的指令和匹配 ZIP 一起上传到 Muse 主聊天，要求主代理完整执行：

| 版本 | 完整一键部署指令 | 必须启动的原生角色 |
| --- | --- | --- |
| v0.3.0 | [v0.3.0-一键部署.txt](guides/v0.3.0-一键部署.txt) | 默认一个原版常驻 worker，直接领取并回复 |
| rc.5 | [rc.5-一键部署.txt](guides/rc.5-一键部署.txt) | 默认一个常驻 worker，本地耗时工具最多两个后台 job |
| rc.7 负责人模式 | [rc.7-负责人一键部署.txt](guides/rc.7-负责人一键部署.txt) | 一个负责人＋两个真实草稿执行者 |

每份外部指令包含当前 ZIP SHA256，包内均有 `docs/给Muse一键部署的指令.txt`。主代理在扫码后继续启动服务与原生角色，用户完成必要扫码或平台授权。安装、实际持续消费、巡检通知和整体刷新恢复分别核验，不能将桥安装成功等同全部完成。下面是手工步骤。

## 选择版本并核验

优先从 [首页](README.md)下载对应 ZIP，把同目录 SHA256SUMS.txt 中的值作为校验依据。rc.5 多媒体增强的部署指令在 [guides/rc.5-入站多媒体部署验收.txt](guides/rc.5-入站多媒体部署验收.txt)；其中基础提交只是来源记录，必须使用本次构建的 ZIP。

Linux 校验：

```bash
sha256sum muse-link-v0.4.0-rc.5-clean-install.zip
```

ZIP 解压后，以包含 `package.json` 的目录为安装根。v0.3.0 和 rc.7 的 ZIP 带 `muse-link/` 顶层目录；rc.5 的 ZIP 文件直接位于包根。

也可以下载整个仓库，再进入选定源码目录：

```bash
git clone https://github.com/xianjia95-oss/muse-wechat-clawbot.git
cd muse-wechat-clawbot/versions/v0.4.0-rc.5
```

另两个目录是 `versions/v0.3.0` 与 `versions/v0.4.0-rc.7-owner`。

## 新环境安装

1. 确认 Node.js 24+、npm、运行中的 systemd，以及 root 或非交互 sudo 权限；微信账号已启用 ClawBot。
2. 以 Muse HOME 属主进入选定源码根目录，执行 `bash deploy/install.sh`，不要给整个脚本加 sudo。
3. 执行 `export PATH="$HOME/.local/bin:$PATH"`。安装器生成或保留私密配置，不会创建真实 Muse worker。
   v0.3.0 原版安装器不复制文档和服务模板；从 ZIP 首次安装后，在已核验源码根执行 `cp -R docs deploy "$HOME/.local/share/muse-link/"` 保留恢复材料。仓库根 bootstrap 已代做。rc.5/rc.7 安装器将配套材料保存到 current。
4. 按该版本 `docs/MUSE.md` 登录；二维码和配对验证码由用户确认。有有效登录时复用，不清库、不重复扫码。
5. 启动服务并检查：

   ```bash
   systemctl enable muse-link
   systemctl start muse-link
   muse-link status
   ```

   普通用户按需为 systemctl 加 `sudo -n`。rc.5/rc.7 还应运行 `muse-link health`，核对登录及至少一轮成功轮询。v0.3.0 的检查命令以它自己的 `docs/MUSE.md` 为准。
6. 让 Muse 主代理根据所选版本的指令创建、查询真实原生任务。安装服务或注册 hook 不等于 worker 已运行。常驻 worker 应持续轮询，不能队列空就退出。

rc.5 必须核对后台 `status.version=0.4.0-rc.5`、`status.build=rc5-inbound-media-20261028`、`capabilities.receive` 包含 image/video/voice；更新 worker 的附件读取指令，再从微信分别发图片、视频和语音验收。

rc.7 负责人模式须先按 `docs/CONVERSATION_OWNER.md` 和 `docs/MUSE_EXECUTORS.md` 安全切换，再启动一个负责人及两个真实草稿执行者。单纯装好桥不会自动产生这三个原生任务。

rc.7 的两个执行者须分别用自身完整真实 handle 绑定独立 slot，先核对空 take 及原生查询，再允许负责人 submit。不要把主聊天、临时标签或另一个任务的 handle 用作 runner。该模式的巡检按包内 `docs/RUNTIME_RECOVERY.md` 的负责人路径执行，历史六消费者恢复指令不适用。

三版都要求常驻角色完成一条后继续轮询，阶段报告不能终结原生任务。主聊天登记巡检，独立巡检通过正式平台入口自动通知原主聊天，由主聊天核实并补位；查询范围受限时保留 unknown。仅当原任务明确终止且没有替代者才创建；未验证通知送达或真实刷新时准确标未接入/未执行。

## 已有部署升级

1. 查询当前服务、真实 worker、未完成租约、后台工具与发送结果；完成任务或私密保存交接。不能盲目中断外部副作用。
2. 暂停 hook，确认旧消费者已停止，再停 `muse-link.service`。
3. 使用已核验的选定版本源码执行 `bash deploy/install.sh`。保留配置、登录、SQLite 与原交接文件，不复制运行凭据到仓库。
4. 启动桥并核验真实后台版本；按所选版本创建或恢复 worker，确认真实 handle 和状态后恢复 hook。
5. rc.5 多媒体增强要同时升级实际 worker 指令。它取得 ready 文件后必须用真实媒体工具打开，不能仅凭路径声称读懂内容。

跨版本回退前须核对兼容性与未完任务，不回滚数据库冒充恢复。不同时运行两套同账号长轮询。环境刷新后的桥与 Muse worker 自动恢复，必须单独核验平台启动入口；本次发布不证明自动恢复已经接通。

## 一键入口的版本参数

仓库根目录的 `deploy/bootstrap.sh` 支持：

```bash
bash bootstrap.sh --version v0.3.0 --install-only
bash bootstrap.sh --version v0.4.0-rc.5 --install-only
bash bootstrap.sh --version v0.4.0-rc.7-owner --install-only
```

它把所选 Git 引用解析为固定提交后下载，并进入对应版本目录安装。已有环境会被拒绝，须按上面的升级流程操作。为了兼容原 rc.7 教程的入口，不带 `--version` 时选择 rc.7 负责人快照；新部署请总是显式填写版本。

`--install-only` 不登录、不启动服务、不创建 worker。rc.7 不加此参数时沿用其扫码激活脚本；v0.3.0/rc.5 安装后按该版本部署指令继续登录和启动。任何扫码或授权仍由用户实际完成。

rc.5 新构建建议增加安装前校验：

```bash
bash bootstrap.sh --version v0.4.0-rc.5 --install-only \
  --require-build rc5-inbound-media-20261028 \
  --require-recovery rc5-recovery-20261029-patrol1
```

入口在运行所选安装器前校验 package.json 的版本及这两项标识，错误或缺失即停止；不会因同为 rc.5 就装入旧构建。远端入口尚未发布这些选项时，使用随附匹配安装包，不去掉校验要求。不能将 install-only 成功记成微信登录、原生 worker 或环境刷新恢复成功；这些按完整指令分别核验。
