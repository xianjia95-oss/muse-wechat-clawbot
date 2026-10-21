# v0.4.0-rc.1 本地验证记录

验证日期：2026-10-21。环境：Windows Node v24.14.1；Docker Debian bookworm Node v24.22.0。以下均为开发机和隔离容器测试，不连接真实微信账号或 Muse 模型。

| 项目 | 结果与范围 |
| --- | --- |
| npm test / Windows | 60 项通过；含协议、媒体加密解密、真实 HTTP/CLI、租约、存储预算、进程锁、备份恢复、步骤核对及观测器。 |
| npm test / Linux | 同 60 项全部通过，含 SIGTERM 排空退出与 SIGKILL 后锁释放。 |
| 本地收发 demo / 两平台 | 接收模拟消息、Muse 任务领取、回复、自动 ack、重复提交缓存通过。 |
| Linux 安装/回滚模拟 | 首次安装、依赖失败不激活、运行中拒绝升级、升级前备份、配置保留、代码回滚和真实 CLI/hook 通过；systemctl 使用隔离模拟，没有验证真实 Muse 的 systemd。 |
| npm audit --omit=dev | 当前审计未发现已知漏洞；不等于独立安全审计。 |
| 实际 Meta Muse hooks | 未执行，需要真实云端环境。 |
| 真实手机文字/图片/视频 | 未执行，accepted 不等于手机收到或视频可播放。 |
| 真实环境 72 小时运行 | 未执行，按生产验收指令收集。 |

本地 60 秒 HTTP/SQLite 压力运行，每批 4 个任务、每个任务续租并写工具步骤，重复提交事件/回复，周期性关闭并重开桥：

| 指标 | Windows | Linux 容器 |
| --- | ---: | ---: |
| 模拟任务 | 1,596 | 1,488 |
| 缓存重试 | 1,596 | 1,488 |
| 关闭重开次数 | 7 | 7 |
| 重复上游消息 | 0 | 0 |
| 进程峰值 RSS（字节） | 224,698,368 | 247,926,784 |
| 状态目录峰值（字节） | 7,126,640 | 6,987,376 |

压力测试的上游固定模拟等待 5ms，以上数据不能证明真实网络延迟、长期内存稳定性或手机送达。最后一轮后续资源边界修复另外通过完整测试；CI 每次也运行 5 秒压力冒烟。复现命令：

```bash
npm ci
npm test
npm run demo
npm run soak -- --duration 60s --report dist/soak-local.json
# 仅在一次性 Linux Docker 容器中：
# bash test/install-smoke.sh
```

真实生产门槛和未完成事项见 [PRODUCTION.md](PRODUCTION.md) 和 [给 Muse 的生产验收指令](给Muse生产验收的指令.txt)。
