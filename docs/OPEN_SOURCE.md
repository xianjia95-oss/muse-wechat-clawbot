# 开源发布说明

仓库名：`muse-wechat-clawbot`。中文名：**Muse 对接微信 ClawBot**。程序名、包名和命令保持 `muse-link`，已有部署无需为仓库改名而迁移。

仓库地址：https://github.com/xianjia95-oss/muse-wechat-clawbot

建议仓库描述：

> Meta Muse 对接微信 ClawBot 的轻量桥：文字收发、生成图片与视频回传、任务路由、发送去重和耗时记录。基于腾讯 iLink 协议，MIT 开源。

## 许可证和范围

本项目使用 [MIT](../LICENSE)。允许使用、修改、分发和商用，须保留版权及许可声明。第三方声明见 [THIRD-PARTY.md](../THIRD-PARTY.md)，并保留 `LICENSE.tencent`。

公开源码包含 `src/`、`deploy/`、`docs/`、`test/`、当前打包与演示脚本、配置示例和项目维护文件。

`private: true` 防止意外发布到 npm，与 GitHub 公开仓库及 MIT 许可证无冲突。

## 首次发布到 GitHub

1. 登录自己的 GitHub 账号，在账号或组织下新建 Public 仓库 `muse-wechat-clawbot`。不要勾选自动创建 README、许可证或 .gitignore，本地已有这些文件。
2. 在本地运行 `git status --short`，确认没有登录凭据、数据库、二维码或聊天记录。`.gitignore` 是辅助保护，不能代替查看拟提交的文件。
3. 首次提交当前公开源码，再将 GitHub 新仓库页面提供的地址设为 `origin` 并推送。命令示例：

   ```bash
   git add .
   git diff --cached --stat
   git commit -m "Initial open-source release of Muse Link"
   git branch -M main
   git remote add origin https://github.com/xianjia95-oss/muse-wechat-clawbot.git
   git push -u origin main
   ```

   以上为当前项目的地址；发布自己的分支项目时替换成自己的仓库地址。已有 origin 时先核对 `git remote -v`，不要直接覆盖或强制推送。GitHub 登录应使用本机登录流程，不在命令或聊天里粘贴访问令牌。
4. 为仓库设置上方描述，建议 topics：`muse`、`wechat`、`clawbot`、`ilink`、`nodejs`。在仓库 Security 设置中启用 Private vulnerability reporting。
5. 等待 GitHub Actions 通过；本地通过不代表 GitHub 上的运行已经通过。之后可按下面步骤创建首个 Release。

## 发布 0.4.0-rc.3 候选版

```bash
npm ci
npm test
npm run demo
npm run soak -- --duration 60s --report dist/soak-local.json
python scripts/build_app_package.py
```

构建生成 `dist/muse-link-v0.4.0-rc.3.zip` 与同名 `.zip.sha256`。ZIP 是不含依赖的完整源码包，需在目标环境 `npm ci`，再按 [部署文档](MUSE.md) 安装。GitHub Actions 的 Ubuntu 作业也会上传源码包作为构建产物；工作流不创建 Release、不使用微信凭据、不部署服务。

在本地将验收过的提交打标签 `v0.4.0-rc.3` 并推送标签，然后在 GitHub Releases 创建对应版本，附加 ZIP 与校验和。发布说明使用 [RELEASE_NOTES_v0.4.0-rc.3.md](RELEASE_NOTES_v0.4.0-rc.3.md)。后续发版需同步 `package.json`、lockfile、`src/config.mjs` 的版本及相应文档；不要覆盖已经发布的同版本资产。

版本说明应保留实际能力边界：本地模拟通过，真实 Muse hooks、微信手机收取及视频播放待验收；不承诺固定耗时，不声称读取微信图片或视频。

候选版在 GitHub 勾选 prerelease；保留已有 v0.3.0 资产。CI 另运行本地 stress 和 Linux 安装/回滚模拟。只有 [生产验收](PRODUCTION.md#真实验收与发布门槛) 的真实环境项目完成，才能判断部署可上线；不要将候选版改称已通过 72 小时测试。
