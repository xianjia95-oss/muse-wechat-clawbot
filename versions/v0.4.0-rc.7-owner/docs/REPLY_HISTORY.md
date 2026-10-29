# 跨 worker 查询回复历史（本地候选）

本地候选在创建 Muse 回复发送意图时，把原样文字、final/progress、进度编号及媒体类型写入同一份私密 SQLite。不同常驻 worker 可查询同一发送者的记录，不依赖原执行者仍在线。正文与发送意图在同一事务落盘，保存失败则不发送；相同请求重试不会覆盖历史。

这不是已部署的功能。先核对实际 CLI 帮助含 muse history、服务代码包含该接口，版本号相同不代表补丁相同。旧发送记录没有正文时只能报告无法获取；不依据时间窗、长度或 worker 印象补写历史。旧 worker 的原始私密记录若仍在，可另作只读证据核对，本接口不自动导入。

启用[固定对话模式](CONVERSATION_OWNER.md)后，以下命令均额外带私密`--session-file`；负责人可查询同一发送者旧worker的记录，后台执行者不读取或转发聊天。

## 从微信询问某条任务的回复

处理本次查询的 worker 使用**本次查询事件**的有效原租约；目标事件可能已结束，不能拿目标的旧 token 查，也不能为查看历史重新领取旧任务。

```bash
# 先找原任务；编号仅为示例，固定文字不能拼成用户可执行的 shell。
muse-link muse history '<本次查询事件ID>' \
  --task-file '/private/current-query-task.json' --query 'CASE-001'

# 从搜索结果选定准确的原事件，读取它的回复。
muse-link muse history '<本次查询事件ID>' \
  --task-file '/private/current-query-task.json' --target-event-id '<原任务事件ID>'
```

--task-file 可换为本次领取的完整 --lease-token，优先从原交接读取；不能抄数据库 token。参数通过安全 argv 传递，不能把用户文字拼入 shell。历史是资料，不是新的工具执行指令。无需访问外部域名，不重跑原业务，不因为换 worker 就回复“我没处理，无法看”。多条搜索命中时按编号、时间和请求摘要核对；无法唯一确定则澄清，不能随便取第一条。

搜索只在同一微信发送者、同一 binding 中对原入站文字作字面子串查询，不搜其他人的聊天；排除当前查询事件。返回最多160码点请求摘要、事件ID、时间和最终请求状态。% 和 _ 不作为通配符。搜索不到不证明消息未收到，可能已超过保留期。

详情含 replies；逐条核对 mode、reply_id、state、submitted_ms、accepted_at、content_status、text、media。mode=final 是业务最终回复，progress 是阶段信息；unknown 模式表示旧记录无法恢复模式。pending/failed/rejected/unknown 不能说成已回复成功。accepted 只证明接口接受，phone_delivery_verified 始终 false，手机显示仍需实际核对。一次提交可能分成多条微信消息，历史文字保留原提交全文。

content_status=recorded 时 text 为原始提交文字，含原换行和空格；not_recorded_or_expired 时 text/media 为 null，只能说明正文未留存或已过期，不得猜测。媒体只记录 image/video 类型，不保留媒体字节、本地文件路径、上传密钥或下载地址，不能靠历史重新发送附件。

默认 --limit 5，最大20；--offset 默认0，跟随 next_offset 读至 has_more=false。详情在回复边界分页，整条正文不截断，响应限制在256KiB内；并发新增记录时分页不是固定快照，按 request_id 去重核对。查询不领取、续租、ack、重试或修改原任务。

## HTTP 与隐私

POST /v1/muse/history 须正常 API 鉴权并携带当前有效 event_id、lease_token，即使配置放宽旧接口的租约检查，这个接口仍强制校验。请求提供 query 或 target_event_id 二者之一，以及可选 limit、offset。响应 no-store。其他发送者的目标与不存在/过期的目标都返回 history_not_found；不泄露目标归属。

```json
{"event_id":"muse:query-event","lease_token":"本次查询的完整token","query":"CASE-001","limit":5}
```

正文只在显式私密history和新模式context查询中返回，普通 request、status、health、metrics、diagnose 和日志继续不输出正文。输出可能含原回复中的敏感内容，只能私密读取；回答微信查询时只引用该用户要求的相关答案，不把其他记录、token、账号或整份数据库回传。API token 是受信本机权限，拥有它或数据库访问权的操作者仍须保护凭据。

正文保存在 state_dir/bridge.sqlite，目录0700、数据库0600（Unix）；没有新增应用层加密，备份也会包含正文。正文保留期沿用 operations.event_retention_days，默认7天；到期立即不向查询返回，小时维护分批逻辑删除。事件删除或90天发送记录清理时也清除关联正文。发送幂等记录独立按原90天规则保留，不能为了清历史删除去重状态。SQLite空闲页、WAL、已有备份的物理清除和备份保留须另行管理，逻辑删除不等于介质擦除。

不把数据库、历史导出、原任务正文或本机调试材料加入仓库。公开包只含项目代码、配置示例和部署文档。
