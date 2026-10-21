# 从 Muse 回传图片和视频

v0.3.0 起实现 Muse → 微信的图片、视频发送：本地文件检查 → 加密快照 → 获取上传地址 → CDN 上传 → 发送媒体消息 → 微信接口确认 → 最终回复自动完成事件。没有新增 npm 依赖，不需要 ffmpeg 常驻。真实账号收取、缩略图显示及视频播放兼容性尚待云端验证。

## 支持范围

| 方向或类型 | 当前能力 |
| --- | --- |
| Muse 生成图片 → 微信 | 发送 PNG/JPEG/GIF/WebP 文件，单张最多 20 MiB。 |
| Muse 生成视频 → 微信 | 发送 MP4/MOV 容器文件，单个最多 50 MiB；不转码，手机播放取决于微信支持的编码。优先使用 H.264/AAC MP4。 |
| 文字和多个附件 | 一次最多 4 个媒体；可带文字，先文字再按媒体数组顺序发送。 |
| 微信图片/视频 → Muse | 尚未实现下载和读取，入站事件明确报告 media_errors。 |
| 普通文件、原始语音 | 暂不支持；微信附带的语音转写可读取。 |

大小是本包限制，不表示服务端一定接受该大小或格式。程序检查文件头、大小与目录，不完整解码文件；测试不能代替手机播放验收。

## 路径与配置

media.path 是桥运行的 Muse 云端 Linux 中的绝对文件路径。默认允许 ~/workspace；在 ~/.config/muse-link/config.json 的 media_roots 中加入生成工具实际输出目录，随后重启服务。例如：

```json
{
  "media_roots": ["~/workspace", "/absolute/muse-generated-media"],
  "media_timeout_ms": 120000
}
```

上面只是要合并的字段，保留原 token、binding、state_dir 等配置，不要用它覆盖整个配置。只添加实际输出目录；符号链接按真实路径检查。空数组关闭媒体读取。旧配置省略字段时采用默认值，不会改写原配置文件。

文件必须已完整生成并能由服务用户读取；如果 Muse 工具只返回内部媒体 ID、网页预览或 URL，须先用 Muse 的实际工具把原文件导出到允许目录。桥不接受远程 URL，不能把预览链接当成本地路径。

## 发送命令

先通过 muse next 领取事件，使用真实 event_id 及本次 lease_token；长任务续租并记录生成步骤。图片或视频可以没有文字：

```bash
muse-link muse reply '<event_id>' --lease-token '<lease_token>' --image "$HOME/workspace/result.png"
```

另一个事件回复视频：

```bash
muse-link muse reply '<另一个 event_id>' --lease-token '<lease_token>' --video "$HOME/workspace/result.mp4"
```

同一最终回复带文字与图片/视频：

```bash
muse-link muse reply '<event_id>' --lease-token '<lease_token>' \
  --image "$HOME/workspace/result.png" \
  --video "$HOME/workspace/result.mp4" \
  --text - <<'MUSE_REPLY'
这是生成结果。
MUSE_REPLY
```

--image、--video 可重复；CLI 先放所有图片，再放所有视频，需要交错顺序可用 JSON API 的 media 数组。路径和 heredoc 都要正确引用，不能把用户文本拼进 shell。

生成较久时，先发 --progress --reply-id started 的文字确认，再生成并用最终 reply 提交全部结果。预览图也能用 --progress --reply-id preview 发送。最终 reply 全部确认后自动 ack；不能先用最终文字回复完成事件，再试图向同一事件补图。生成任务的执行去重仍由 Muse 持久化记录。

## 重试与耗时

一次请求的 ID 绑定文字、媒体类型和路径，以及各媒体首次成功准备的文件快照。上传前先检查并加密全部文件，避免路径或格式错误时已经发送说明文字。桥使用流式加密并上传磁盘快照，避免整段视频占据内存；快照在 state_dir/outbox 中，私密数据库保存密钥。

同一 ID 的重复提交使用原快照；即使源文件改变也不会换成新内容。成功后重复提交只返回缓存，不重新发送。若要有意发送新的生成结果，应使用新的微信任务或新的进度 reply-id；不要借此绕过 unknown 的核对。

上传失败时 state=failed、retryable=true，可在修复后用原事件、原文字及原媒体路径重试；已确认的说明文字或附件会跳过。若上传参数已保存，续传可以使用已准备的媒体引用。failed 不会在后台无限重试。微信 sendmessage 的响应丢失则为 unknown，必须核对后处理，不自动重发。最终回复失败时不 ack。

已确认附件的加密快照会尝试清理；失败或不确定结果保留快照，供原请求恢复。不要在待恢复请求处理前清空 outbox；强制终止进程可能留下临时文件。大视频的上传和同一收件人的排队会增加耗时。timing.media_prepare_ms、media_upload_ms、send_message_ms 分别显示准备、上传和消息确认时间；本地文字模拟的毫秒数不能用来承诺视频速度。

## 升级和真实验收

将 v0.4.0-rc.3 部署包与更新后的“给 Muse 的指令”一起交给 Muse。按 docs/MUSE.md 的升级步骤暂停 hook、停止旧 muse-link、安装并重启，保留原配置和 SQLite 状态。重新注册或更新旧 hook 中的“只能纯文字”指令。检查服务 status 的 version=0.4.0-rc.3，capabilities.send 包含 image、video；只查看新 CLI 的 --help 不足以确认后台已升级。

从微信分别要求生成一张小图片和一个短 MP4。Muse 应报告真实本地路径、request_id、上传及发送耗时；在手机核对图片能打开、视频可播放。图片和视频都通过后，再检查文字与多个附件、重复提交无重复发送、上传失败续传。接口 accepted 不代表手机已收取或可播放。

候选版的 failed/unknown 媒体快照默认最多保留 7 天；过期清理前将 failed 冻结为 unknown，不允许缺少原快照后换文件续发。超过 24 小时的无引用临时文件由维护清理。空间预算、备份、去重期限和恢复流程见 [生产运行](PRODUCTION.md)。
