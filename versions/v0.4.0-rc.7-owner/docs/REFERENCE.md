# 接入与协议说明

Muse Link 直接使用微信 iLink 协议连接账号，通过本地持久化和 Muse 原生 hooks 交接任务。以下说明覆盖本项目的接入流程、接口行为和真实账号验收要求。

## 接入路径

微信 ClawBot → iLink getupdates 常驻长轮询 → SQLite 收件箱 → Muse 原生 hook → 真实工具 worker → muse reply → iLink sendmessage → 微信。

| 环节 | Muse Link 实现或交付要求 |
| --- | --- |
| 运行环境 | 安装器在 Muse 云端部署。需确认 Node.js 24+、systemd、权限与实例持续运行能力。 |
| 账号登录 | 按微信实际界面启用 ClawBot，再扫码授权；login 输出唯一二维码路径，记录微信确认结果。 |
| 接收与任务处理 | systemd 服务负责收发；hook 必须在真实 Muse 环境注册并启用，检测脚本本身不具备模型或工具执行能力。 |
| 待办检测 | 建议 5 秒，最终间隔以 Muse 支持并实际生效的值为准。回复提交后直接发送，不等下一轮扫描。 |
| 工具调用验收 | 验收“获取当前 UTC 时间及 Node.js 版本”，保留真实工具记录和手机收到的结果。 |
| 手机配对验证码 | 支持 need_verifycode、错误重输、被阻止及已绑定的明确处理，后台登录可从私密临时文件接收数字。 |
| 双向多媒体（本地候选） | 图片、视频、语音下载解密与私密文件交接；本地媒体可回传，WAV/SILK实际转换。真实Muse理解与手机播放待验证，见[MEDIA.md](MEDIA.md)。 |

## 需要区分的协议细节

iLink 的 getupdates 在有消息或长轮询超时后返回，longpolling_timeout_ms=35000 是等待参数。有消息可提前返回，35 秒不是每条消息的固定延迟，也不是已提交回复的发送等待时间。

对“任务已完成，微信很晚才收到”，分别记录真实结果就绪 → 桥提交（model_to_submit_ms）、桥排队（queue_ms）、微信接口确认（upstream_ms）、手机显示时间。当前协议及桥不提供手机送达回执，accepted 仅表示接口已确认。

本包以最多 5 分钟作为本地换码上限，并允许微信提前返回 expired。日志 expires_at 标记 expiry_source=client_refresh_limit，不能作为服务端有效期承诺。

扫码直连 /ilink/bot/get_bot_qrcode 和 /ilink/bot/get_qrcode_status；登录成功须以 confirmed 状态和有效凭据为准。命令输出 submitted=true 仅表示已提交配对验证码。

媒体发送流程是计算明文大小与 MD5、AES-128-ECB/PKCS#7 加密、getuploadurl、上传 CDN 并获取 x-encrypted-param，最后通过 sendmessage 发送媒体引用。本项目按此流程处理本地文件，图片 item.type=2、视频 item.type=5、语音 item.type=3，上传 media_type 分别1/2/4。视频不转码或上传缩略图；语音WAV转SILK使用锁定的silk-wasm。语音playtime单位为毫秒，SILK encode_type=6、MP3=7。

本地媒体协议核对参考腾讯npm包[@tencent-weixin/openclaw-weixin 2.4.10](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin/v/2.4.10)的类型、CDN下载及解密实现，参考包不是运行依赖。入站使用media.full_url或encrypt_query_param；image_item.aeskey的32位hex优先，media.aes_key兼容base64的16原始字节或32位ASCII hex；无key图片兼容明文变体。桥验证来源、流式解密、限额落盘，下载不使用聊天认证头；不由协议字段推断Muse已有理解能力。

## 仍须在 Muse 验证

Muse hook 须通过当前运行环境实际提供的工具注册、dry_run、启用，并报告 hook 标识、工具权限和检测间隔。部署验收必须覆盖接收进程、worker 执行、回复提交、微信确认及手机收取；这些结果必须在实际部署中确认。
