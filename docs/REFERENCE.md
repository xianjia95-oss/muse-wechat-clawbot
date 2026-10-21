# 参考教程与腾讯协议核对

核对日期：2026-10-20。参考 [UPGPTs 实操教程](https://upgpts.com/en/tutorials/muse/muse-wechat)（页面标注 2026-10-18 发布及更新）、其引用的 [腾讯 openclaw-weixin 协议](https://github.com/tencent/openclaw-weixin/blob/HEAD/docs/protocol_zh_CN.md) 与 [二维码登录源码](https://github.com/tencent/openclaw-weixin/blob/HEAD/src/auth/login-qr.ts)。教程提供部署思路；协议和源码描述参考客户端行为，真实账号仍须验收。

## 接入路径

微信 ClawBot → iLink getupdates 常驻长轮询 → SQLite 收件箱 → Muse 原生 hook → 真实工具 worker → muse reply → iLink sendmessage → 微信。

| 教程做法 | Muse Link 实现或交付要求 |
| --- | --- |
| 在 Muse 自己的 Linux 云端运行，不额外购买服务器 | 安装器在 Muse 云端部署。需确认 Node.js 24+、systemd、权限与实例持续运行能力。 |
| 启用 ClawBot，再扫码授权 | 按微信实际界面启用；login 输出唯一二维码路径，记录微信确认结果。 |
| 分别配置消息监听进程与工具 worker hook | systemd 服务负责收发；hook 必须在真实 Muse 环境注册并启用，检测脚本本身不具备模型或工具执行能力。 |
| 15 秒扫描待办目录 | 本包建议 5 秒，最终间隔以 Muse 支持并实际生效的值为准。回复提交后直接发送，不等下一轮扫描。 |
| 从微信验证实际工具调用 | 验收“获取当前 UTC 时间及 Node.js 版本”，保留真实工具记录和手机收到的结果。 |
| 手机可能要求验证码 | v0.2.1 新增 need_verifycode、错误重输、被阻止及已绑定的明确处理，后台登录可从私密临时文件接收数字。 |
| 可生成并回传图片 | v0.3.0 实现从本地文件回传图片/视频，已做本地协议测试；真实微信收取及视频播放待验证。入站附件下载尚未实现。 |

## 需要区分的协议细节

腾讯协议规定 getupdates 在“有消息或长轮询超时后返回”，响应示例中的 longpolling_timeout_ms=35000 是等待参数。有消息可提前返回，不能照搬教程里“35 秒 + 15 秒 + worker 时间”的公式作为每条消息的固定延迟，更不能用它解释已提交回复的发送延迟。

对“任务已完成，微信很晚才收到”，分别记录真实结果就绪 → 桥提交（model_to_submit_ms）、桥排队（queue_ms）、微信接口确认（upstream_ms）、手机显示时间。当前协议及桥不提供手机送达回执，accepted 仅表示接口已确认。

腾讯参考登录客户端的活动二维码期限为 5 分钟；本包以最多 5 分钟作为本地换码上限，并允许微信提前返回 expired。日志 expires_at 标记 expiry_source=client_refresh_limit，不能作为服务端有效期承诺。

教程引用的 [微信开放文档 Clawbotrelated](https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html) 展示了 /api/v1/wechat/qrcode 等包装接口，响应 credentials 包含登录凭据。它与本包直连的 /ilink/bot/get_bot_qrcode、get_qrcode_status 并非同一路径或响应结构，不能混用。

腾讯协议的媒体发送流程是计算明文大小与 MD5、AES-128-ECB/PKCS#7 加密、getuploadurl、上传 CDN 并获取 x-encrypted-param，最后通过 sendmessage 发送媒体引用。v0.3.0 按此流程流式处理本地文件，图片 item.type=2、视频 item.type=5，no_need_thumb=true；未实现转码或缩略图上传。实现细节于 2026-10-21 复核 [腾讯媒体发送](https://github.com/tencent/openclaw-weixin/blob/HEAD/src/messaging/send.ts) 与 [CDN 上传](https://github.com/tencent/openclaw-weixin/blob/HEAD/src/cdn/cdn-upload.ts) 的协议字段和行为。

## 仍须在 Muse 验证

教程没有给出 Muse hook 注册工具的完整请求及返回结构。本包不推测这一接口；须由 Muse 使用自身实际工具注册、dry_run、启用，并报告 hook 标识、工具权限和检测间隔。部署验收必须覆盖接收进程、worker 执行、回复提交、微信确认及手机收取；本地测试无法代替这些结果。
