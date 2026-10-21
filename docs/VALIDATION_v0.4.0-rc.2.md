# v0.4.0-rc.2 本地验证记录

日期：2026-10-21。Windows Node v24.14.1；Docker Debian bookworm Node v24.22.0。未连接真实微信账号或 Muse 模型。问题与修复见 [复审记录](AUDIT_v0.4.0-rc.2.md)。

| 检查 | 结果 |
| --- | --- |
| 完整测试 / Windows | 73 项通过，0 失败，包含新增 13 项审计回归。 |
| 完整测试 / Linux | 同 73 项通过，0 失败，包含真实进程锁/停机、HTTP/CLI、媒体和备份恢复。 |
| 本地 demo / 两平台 | 模拟微信接收、任务领取、Muse 回复、ack、同 ID 缓存通过，仅发送一条上游消息。 |
| Linux 安装/回滚 | 首装、依赖安装失败不激活、运行中拒绝升级、备份后升级、配置保留、代码回滚及 hook 检查通过。systemctl 为容器内模拟。 |
| npm audit --omit=dev | 0 个已知依赖漏洞。 |
| 真实 Muse/微信/72 小时 | 未执行，须在实际部署完成。 |

两平台各 60 秒本地 HTTP/SQLite 压力运行，模拟上游每次等 5ms，含续租、步骤日志、重复事件/回复和关闭重开桥：

| 指标 | Windows | Linux |
| --- | ---: | ---: |
| 任务 / 缓存重试 | 1,344 / 1,344 | 1,300 / 1,300 |
| 重复上游消息 | 0 | 0 |
| 关闭重开次数 | 6 | 6 |
| 峰值 pending | 4 | 4 |
| 峰值状态目录字节 | 6,676,080 | 6,585,896 |
| 峰值进程 RSS 字节 | 220,176,384 | 215,539,712 |
| 模拟桥延迟 p50 / p95 ms | 47.07 / 82.58 | 47.38 / 87.49 |

这些数字是同一开发机并行运行测试和容器时的模拟结果，不能推算真实微信耗时或长期容量，也不是 72 小时稳定性结论。token 格式最后调整为兼容已有 Base64 值后，另对两平台审计回归复验；发布时以精确发布提交的 GitHub CI 完整验证为准。

```bash
npm ci
npm test
npm run demo
npm run soak -- --duration 60s --report dist/soak-local.json
npm audit --omit=dev
# 仅在一次性 Linux 容器执行：bash test/install-smoke.sh
```

源码归档使用 scripts/build_app_package.py 的公开文件白名单；发布应附 ZIP 的 SHA256，保持 rc.1 不变。实际生产验收继续使用 [PRODUCTION.md](PRODUCTION.md)。
