# WeChatAgent Desktop 0.4.6

本版本基于 WeChatAgent 0.4.5，发送方式从 Hook 切换为 OCR 或 Windows UI Automation（UIA）。它使用微信 4.2.0.53，需要保持 Windows 会话解锁、微信已登录且窗口可操作。OCR 自动布局使用暗色界面。发送原生语音还需要 VB-CABLE 虚拟音频线路。

请在新的数据目录选择微信、连接 Reader 和 DSH，并按完整微信 ID 添加好友和群。

- [源码运行与 Windows 安装包构建](docs/INSTALLER_RELEASE.md)
- [发送、焦点交接与草稿恢复](docs/FOREGROUND_INPUT.md)
- [离线补读与回执](docs/OFFLINE_RECOVERY.md)
- [本地语音识别](docs/LOCAL_WHISPER.md)和[本地语音合成](docs/LOCAL_GPT_SOVITS.md)

上游已发布的 0.4.5 使用微信 4.2.0.12。该版本的下载和历史变更见[上游 0.4.5 发布记录](docs/releases/0.4.5.md)。
