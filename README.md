# Muse Link — Muse 对接微信 ClawBot

仓库：[muse-wechat-clawbot](https://github.com/xianjia95-oss/muse-wechat-clawbot)。使用 [MIT 许可证](LICENSE)，允许使用、修改、分发和商用；分发时须保留版权及许可声明。项目独立开发，与 Meta、腾讯无官方隶属或背书关系。

为 Meta Muse 自行开发的微信桥，重点测量并改善“结果已准备好，回微信却很慢”的回传链路。直接使用 iLink 协议，独立运行。

回复提交后立即发送，接收长轮询与发送使用独立连接池。每条回复有稳定请求 ID、分段确认记录和耗时，支持进程重启后核对不确定结果。长文本每 2000 个 Unicode 码点顺序发送，无定时批量转发。

当前 **v0.4.0-rc.4** 为单账号、单实例的生产加固候选版：增加状态独占锁、租约校验和工具步骤日志、容量/磁盘保护、readiness、保留策略、离线备份恢复及升级回滚。完整上线条件见 [生产运行与验收](docs/PRODUCTION.md)，真实 Muse hooks、手机收取/播放及 72 小时运行尚待验证。

rc.4 修复恢复已发送任务时误报空队列，新增 Linux 后台工具监督器、完成结果唤醒和只读逐条回执核查。生图/API 超时拖住连发消息时，须同步采用 [连续消息处理流程](docs/BURST_MESSAGES.md)，让单个 Muse 消息循环继续接待短消息；仅升级桥不会自动改掉同步等待工具的 worker。

rc.3 修复旧 inbox 命令与后台状态锁冲突，默认只领取一个任务，并区分租约拒绝的具体原因。新增领取结果的私密文件保存，用于 [跨班次交接](docs/MUSE.md#跨班次交接)。无回复时先按 [排查说明](docs/TROUBLESHOOTING.md) 采集只读证据；[rc.2 复审记录](docs/AUDIT_v0.4.0-rc.2.md) 保留供查阅。

v0.3.0 已实现 Muse 生成图片、视频后从本地文件回传微信：流式加密上传、独立上传连接池、上传失败续传和发送结果去重，不新增运行依赖。保留扫码与手机配对验证码、文字收发、入站微信语音转写、SQLite 收件箱、Muse 任务接口、自动路由及确认、本人白名单、私密本地 API 和 Linux systemd。

图片/视频回传已通过本地 HTTP 协议模拟与解密校验，实际微信接收和视频播放兼容性仍待 Muse 云端验收。读取微信发来的图片/视频、原始语音及文件传输尚未实现，入站附件会明确报告不支持。

Muse 在自己的运行环境中通过原生 hooks 接收任务并执行；本项目负责微信连接和任务交接，不代替 Muse 模型。未提供或假设一个未经验证的 Muse 公共 API。部署必须同时完成接收服务与真实 Muse 工具 worker 的 hook 注册，只安装接收服务不能执行微信任务。升级旧版本必须暂停 hook、停服务、备份并同步更新 worker 的 lease_token 协议。

## 运行

需要 Node.js 24+：

```bash
npm ci
node src/cli.mjs init
node src/cli.mjs login
npm start
```

另开终端运行 `node src/cli.mjs status`。用户先在微信启用 ClawBot 插件，并发消息建立回复上下文。扫码命令打印唯一图片路径，单码客户端等待上限 5 分钟，微信可能提前返回过期；确认后删除图片。手机若要求输入配对数字，按登录日志的 verification_required 和 [验证码步骤](docs/MUSE.md#手机要求配对验证码时) 继续。

部署到 Meta Muse：将源码上传到 Muse 云端，发送 [部署指令](docs/给Muse的指令.txt)。也可先执行 `python scripts/build_app_package.py`，再上传生成的 `dist/muse-link-v0.4.0-rc.4.zip`。详见 [Muse 部署](docs/MUSE.md)、[图片与视频回传](docs/MEDIA.md)、[API 与耗时](docs/API.md) 和 [接入与协议说明](docs/REFERENCE.md)。

## 发送与定位

Linux 安装后，Muse 领取任务，结果准备好就回复该事件：

```bash
muse-link muse next --lease 30m
muse-link muse reply '<event_id>' --lease-token '<lease_token>' --text - <<'REPLY'
回复正文
REPLY
```

next 返回 tasks，包含事件编号、lease_token、租约截止、正文、语音转写、步骤和完成状态。命令中的占位符须替换为该次领取值。长任务要续租；工具执行前后记录 checkpoint，遗留 started 必须核对，已 completed 的步骤复用结果。参见 [完整 worker 指令](docs/MUSE.md#注册-hook-和完整唤醒指令)。reply 从事件自动找到微信收件人并生成稳定请求 ID，微信确认后自动完成该事件；重复提交相同结果不会重复发出。长任务可加 `--progress --reply-id started` 先回复进度，此时保留任务。桥异常通知需要在 Muse 报告后，用 `muse-link muse ack '<event_id>' --lease-token '<lease_token>'` 确认。

生成的文件位于 config.media_roots（默认 ~/workspace）内时，可直接回传：

```bash
muse-link muse reply '<event_id>' --lease-token '<lease_token>' --image "$HOME/workspace/result.png"
muse-link muse reply '<另一个 event_id>' --lease-token '<lease_token>' --video "$HOME/workspace/result.mp4"
```

一条最终回复可同时带文字和最多 4 个媒体文件；图片上限 20 MiB、视频上限 50 MiB，这是本包的本地限制，微信服务端也可能拒绝。请先读 [媒体说明](docs/MEDIA.md)，同一事件成功最终回复会自动完成，不能先发文字结束再另发图片。

返回 timing 区分排队、微信 API 和桥处理耗时。可选真实结果完成时间还能测完成到提交的间隔。`muse-link request '<request_id>'` 核对单次结果，`muse-link metrics` 看近期统计。成功表示微信接口已确认，不能确认手机显示。底层 send/inbox 命令仍可用于诊断。

Muse Link 通过独立收发连接和耗时记录减少可控开销并定位问题。Muse 收消息仍需平台 hooks（建议 5 秒检测，以平台支持为准），已提交的回复直接发送。iLink 协议要求 getupdates 在有消息或长轮询超时后返回，35 秒不是每条消息的固定等待，不能与 hook 间隔机械相加作为响应耗时。

## 验证与打包

```bash
npm test
npm run demo
npm run benchmark
npm run soak -- --duration 60s --report dist/soak-local.json
python scripts/build_app_package.py
```

测试包含 Muse 任务路由、自动确认、进度回复、真实命令行文字/图片/视频调用、媒体加密解密与 HTTP 上传、目录与大小限制、失败续传、去重、并发顺序、Unicode 分段、不确定结果禁止自动重发、部分成功、崩溃恢复、事务回滚、租约、QR 登录，以及真实 HTTP 长轮询挂起时仍可发回复。媒体视频测试使用模拟容器数据，不能证明手机播放。demo 在本机模拟微信接口和 Muse 处理器，跑通文字收发与重试，可用 `npm run demo -- --report dist/demo-report.json` 保存报告。benchmark 固定模拟微信响应等待 20 毫秒，两者都不能视作真实 Muse/微信实测。

Muse hooks 注册与实际微信双向收发仍需云端验证。协议和依赖许可见 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 参与和发布

提交问题或改动前请读 [贡献说明](CONTRIBUTING.md)；涉及凭据或安全问题请读 [安全说明](SECURITY.md)。版本记录见 [CHANGELOG.md](CHANGELOG.md)，发布步骤见 [开源发布说明](docs/OPEN_SOURCE.md)。GitHub Actions 在 Linux 和 Windows 上运行 Node.js 24 测试、演示和源码打包，不需要微信账号或 Muse 凭据。

生产候选版另含 Windows/Linux 运维故障测试、Linux 安装/回滚演练和只读 `scripts/observe.mjs`。后者用于真实云端收集 72 小时状态，不发送消息，也不能证明手机收取。直接交给 Muse 执行的 [生产验收指令](docs/给Muse生产验收的指令.txt) 列明尚需完成的项目。
