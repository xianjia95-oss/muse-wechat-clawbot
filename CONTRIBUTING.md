# 贡献说明

感谢帮助改进 Muse Link（仓库名 `muse-wechat-clawbot`）。项目使用 MIT 许可证；提交贡献时，请确认你有权按该许可证提供代码，并保留所引用代码的第三方声明。

## 本地开发

需要 Node.js 24+；源码打包需要 Python 3。安装器仅适用于具备 systemd 的 Linux 环境，普通开发和协议模拟测试可在 Windows 或 Linux 运行。

```bash
npm ci
npm test
npm run demo
python -m unittest discover -s test -p test_public_package.py
python scripts/build_app_package.py
```

测试和演示使用本地模拟接口，不要求微信登录、Muse 环境或 API 凭据。请勿让 CI 登录自己的账号。性能相关改动可再运行 `npm run benchmark`，报告须说明模拟接口的固定等待，不能当成真实微信收取速度。

## 提交问题

请说明版本、操作系统、Node.js 版本、复现步骤、预期和实际行为。耗时问题请提供脱敏后的 timing 字段，并区分任务结果就绪、桥提交、微信接口确认和手机显示。

不要上传真实 token、session、context token、二维码、验证码、SQLite 数据库或聊天原文。安全问题按 [SECURITY.md](SECURITY.md) 处理。

## 提交改动

一个 Pull Request 聚焦一个问题，写明行为变化和验证结果。协议变更请附公开来源；真实账号测试和本地模拟分别说明。新增功能应同步更新部署、API 或媒体文档。

发送链路须保留每个收件人的顺序、稳定请求 ID、已确认分段记录，以及结果不确定时禁止自动重发的语义。修改这些行为应覆盖相应恢复场景。不要把微信消息拼入 shell 命令，也不要把私密本地 API 暴露到公网。

`package.json` 的 `private: true` 仅防止意外发布 npm 包，不影响 MIT 开源或从 GitHub 安装。

源码包只包含 `scripts/public-files.json` 中明确审阅的路径。新增公共文件时逐项更新清单；现场报告、聊天、真实 API 地址、任务标识和调试记录留在本地忽略目录，不加入清单或 Git。清单不会阻止手工提交其他文件，提交前仍须检查完整暂存差异。
