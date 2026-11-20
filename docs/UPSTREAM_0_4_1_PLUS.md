# 上游 0.4.1+ 的选择性移植

后续评估基点已推进至 [v0.4.5（448c7f4）](https://github.com/sourcepro5/WeChatAgent/releases/tag/v0.4.5)。2026-11-16 按功能接入 DSH 0.2.2 工具兼容、语音候选转文字与未提交回退、UIA 普通文件、声明式插件配置表单，以及全局可选的云端语音识别与合成。识别、合成各自默认本地。用法见[日常使用](DAILY_USE.md)，文件实机验收见 [UIA 控件模式](BACKGROUND_CONTROLS.md)。语音服务诊断短句取自该发布版的 `optional-extensions/speech-recognition/assets/config-test.wav`。

2026-10-30 已检查并获取 [sourcepro5/WeChatAgent](https://github.com/sourcepro5/WeChatAgent) 上游更新。当前 `feat/humanize` 保留本地微信界面发送、原生语音、多媒体读取及显示适配；本次按功能移植，没有把整个工作区替换成上游版本，也没有修改本地版本号。

## 来源与范围

- 原先已合入的上游基点：`08c09da6773967dea72acd48ffb5a8c6555e0f9c`。
- 最新发布：[v0.4.1+](https://github.com/sourcepro5/WeChatAgent/releases/tag/v0.4.1%2B)，发布提交 `e98335ca3a610b8e9fa8ff00a99f8a017f8de592`。
- 本次检查的主线：[ebcb6f6d7bf04688db8044f6ce69654bb341d8b4](https://github.com/sourcepro5/WeChatAgent/commit/ebcb6f6d7bf04688db8044f6ce69654bb341d8b4)，包含发布后的修复与回归测试。

下列 9 个文件直接采用该主线版本：

| 功能 | 文件 | 上游来源 |
| --- | --- | --- |
| 微信公众号正文读取 | `packages/dsh-social-bridge-plugin/web-reader-content.mjs`、`web-reader-policy.mjs`；`scripts/test-web-reader.mjs` | 原始修订 `fbc37234198cbd948b418792d5b23413b1ed1681`，合入 `ce6baf0895522347783c1b2f245aa43d8f98c7c0`，最终加固 `ebcb6f6` |
| DSH 会话管理命令 | `scripts/manage-dsh-sessions.mjs`、`test-dsh-sessions-cli.mjs` | 原始修订 `f89053d11f078136a166b5fdb98e4e055000f645`，合入 `a9b6c7c76d6d9fddbd3b80f4fe8f077235d75a58`，最终加固 `ebcb6f6` |
| 增强版版本比较及更新链接 | `scripts/release-version.mjs`、`update-check.mjs`、`test-release-version.mjs`、`test-public-update-check.mjs` | 发布提交 `e98335ca3a610b8e9fa8ff00a99f8a017f8de592` |

公众号正文处理支持已知正文容器等待渲染时的隐藏样式，同时保留隐藏祖先、压缩解码和输出长度限制。会话命令提供中文可执行错误提示和失败退出码，成功时保留 JSON 输出。更新检查能识别增强版、正确编码带 `+` 的发布链接，并限制为官方仓库链接。

## 验证

以下定向测试共 **42 项通过，0 失败，0 跳过**：

```text
node --test scripts/test-web-reader.mjs scripts/test-dsh-sessions-cli.mjs scripts/test-release-version.mjs scripts/test-public-update-check.mjs
```

这些测试使用临时配置和模拟请求；未启动或停止正式机器人，未操作微信，也未修改账号读取配置。这里记录的是这 9 个文件的验证，不替代本地其他改动的验收。

## 当前日期与时区

另按功能移植 PR #27（合入 `3eeb8601e9b2cacef45ed9c69b3026542a6d9107`）及 `ebcb6f6` 的时区加固：`components/qq-bridge/src/core/social-engine.js` 的私聊、群聊和助手任务提示，每次构建都重新写入北京时间（`Asia/Shanghai`），不沿用会话创建时的日期，也不受主机时区影响。群聊“上次发言”的时间差使用同一时钟。本地媒体引用与界面发送改动保留。

`scripts/test-prompt-policy.mjs` 补入上游 3 项日期回归，覆盖午夜、跨月、跨年、主机时区差异、逐次刷新和同一时钟；连同人格边界测试共 **15 项通过，0 失败，0 跳过**：

```text
node --test scripts/test-prompt-policy.mjs scripts/test-wechat-prompt-identity.mjs
```

此处只验证提示构建和人格边界，未操作微信或修改正式服务。

## 未直接移植的上游语音链

上游的插件 `audio_read` 权限、`voice-input-v1` 宿主能力和外部语音识别插件依赖新增的 `/api/v1/voices/:id` 音频接口。当前分支已有消息绑定的 `/images`、`/media` 接口、本地语音识别和视频解析，不能只替换插件契约就宣称兼容，也不应让同一条语音重复进入两条识别流程。

本次保留现有本地识别流程，未接入需要额外服务的上游识别路线。后续若兼容此类插件，需要在现有账号、会话和对象授权范围内提供音频读取适配，再启用对应能力声明。

上游这轮没有更新原生 Hook 的版本适配实现；不能据此声称新增了微信 4.1.15.56 的 Hook 支持或原生语音发送接口。
