# Muse Link v0.4.0-rc.4

修复 Muse next 在队首是“发送 accepted、ack 未完成”的恢复项时，处理后误返回空队列的问题。现在会继续领取后面的真实消息，且不增加预领取量、不重置长等待预算、不绕过取消和租约保护。

为“前一个外部 API 卡住，后续微信消息长期等待”新增 Linux 后台工具监督器和结果唤醒。单个 Muse 消息循环可把可信本地工具脚本交给独立进程，继续处理后续短消息；工具结果私密保存，由 Muse 核对并回传原任务。监督器不调用模型、不读取 token、不自动 checkpoint/回复/ack/重试。稳定 ID 去重，最多两项未完成工作，具备时限、日志预算、取消与显式通知结清；Windows 暂不支持后台监督器。

新增 queue-report.mjs，可直接对现有 rc.3 只读核查逐条接收、最终回复提交/accepted/ack 和发送耗时，不需要 npm 安装或重启。历史成功指标和空队列不能证明每条消息均有回复。平台额外的 90 秒去重、同步等待 shell/API 需要更新真实 worker/hook，单升级桥不能修复这些部署行为。

部署前读 [连续消息流程](https://github.com/xianjia95-oss/muse-wechat-clawbot/blob/v0.4.0-rc.4/docs/BURST_MESSAGES.md)，交给 Muse 执行 [修复指令](https://github.com/xianjia95-oss/muse-wechat-clawbot/blob/v0.4.0-rc.4/docs/给Muse修复连续消息延迟的指令.txt)。真实 Muse 连发/长工具、微信手机收取和长期运行仍待验证，不能把本地模拟耗时称为真实速度。
