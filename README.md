<h1 align="center">WeChatAgent</h1>

<p align="center">让微信成为你的 AI 聊天伙伴与远程任务入口</p>

<p align="center">
  <a href="https://github.com/sourcepro5/WeChatAgent/stargazers">
    <img src="https://img.shields.io/github/stars/sourcepro5/WeChatAgent?style=flat-square&amp;logo=github&amp;logoColor=white&amp;label=Stars&amp;labelColor=374151&amp;color=d4a72c" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/sourcepro5/WeChatAgent/network/members">
    <img src="https://img.shields.io/github/forks/sourcepro5/WeChatAgent?style=flat-square&amp;label=Forks&amp;labelColor=374151&amp;color=64748b" alt="GitHub Forks" />
  </a>
  <a href="https://github.com/sourcepro5/WeChatAgent/issues">
    <img src="https://img.shields.io/github/issues/sourcepro5/WeChatAgent?style=flat-square&amp;label=Issues&amp;labelColor=374151&amp;color=64748b" alt="GitHub Issues" />
  </a>
</p>

WeChatAgent 支持好友和群聊的人格对话与独立上下文。连接 DeepSeek Harness（DSH），还能通过微信交办已授权的任务。
有问题可以添加Q群：550582874

**[构建本分支的 Windows 安装器](docs/INSTALLER_RELEASE.md#构建安装器)** · [快速开始](#快速开始) · [语音设置](#语音设置) · [插件下载](#插件安装) · [使用教程](#使用教程) · [发布说明](RELEASE_NOTES.md)


## 能做什么

- **人格聊天**支持为每个好友或群聊分别设置人格、保留上下文。模型可以结合文字、图片、表情和引用消息决定怎样回应。
- **远程助手**：通过微信交办任务，使用当前聊天已授权的 DSH 工具与技能。
- **语音对话**：转写收到的微信语音。配置语音对话 API 后，DSH 可以沿用当前人格和上下文，按每轮对话选择文字回复或微信原生语音。
- **能力扩展**：按需启用联网搜索、公开网页阅读和 ZIP 插件，为指定聊天配置能力与权限；插件可自带页面和配置页。
- **界面主题**：默认液态玻璃，另有“罗德岛 · PRTS”“冻土与火种”两套主题预设，可在顶栏“更多 → 主题预设”切换。

## 开始之前

- 准备 Windows 10/11 x64 和微信 4.2.0.53，在这台电脑上登录微信。
- 单独安装 DeepSeek Harness（DSH），并配置可用的模型账号。图片理解需要支持图片输入的模型。
- 想让机器人发送微信语音气泡时，还需要在本机配置 VB-CABLE 虚拟音频线。
- 模型调用、搜索等能力可能消耗额度。首次启动时允许回复的聊天名单为空。

Windows 安装包已包含 Node.js、Python、OCR 运行环境和桌面发送组件。使用源码运行时，请先安装 Node.js 22.13 或以上版本和支持 venv 的 Python，再按[源码准备](docs/INSTALLER_RELEASE.md#源码准备)启动控制台。

## 快速开始

完成以下步骤，让 AI 回复第一个好友。

### 1. 下载并安装

本分支面向微信 4.2.0.53。可按[源码准备](docs/INSTALLER_RELEASE.md#源码准备)直接运行，也可按[构建安装器](docs/INSTALLER_RELEASE.md#构建安装器)从当前提交生成 Windows x64 安装包。

运行安装器并选择安装根目录。程序放在 `app/`，配置、缓存和运行数据保存在同级的 `data/`。

### 2. 连接微信

1. 打开 WeChatAgent，在“设置 → 微信与 DSH”选择已安装的 `Weixin.exe`，确认微信已登录。
2. 自动查找并选择当前账号，完成数据库连接验证。
3. 在“微信发送方式”中，将发送按键设置成与微信一致的 Enter 或 Ctrl+Enter。默认通过 OCR 定位，开启“UIA 快速模式”可改用控件定位。

发送时会短暂借用微信窗口的焦点。需要在同一台电脑上继续工作时，可以设置“你在用电脑时延后发送”。[桌面发送设置](docs/FOREGROUND_INPUT.md)

### 3. 连接 DSH

1. 按引导单独安装或选择已有的 DSH。
2. 登录自己的模型账号。
3. 复制引导提供的插件路径，在 DSH 中添加并启用插件。
4. 从托盘完整退出 DSH，再重新打开。

详细步骤见 [连接 DSH](docs/EXTERNAL_DSH.md)。

### 4. 添加第一个聊天

从旧 fork 或使用数字聊天 ID 的版本切换时，请在新的安装根目录开始配置，并在这里重新选择好友或群。

1. 进入“聊天”，添加一个用于测试的好友。
2. 点击“设置此聊天”。
3. 选择聊天模式和人格，保存设置。
4. 按界面提示应用配置，然后启动服务。

### 5. 验证回复

请对方发送：

> 你好，介绍一下自己。

**完成标志：** 微信收到回复，聊天历史中出现对应记录。

如果没有回复，先检查允许范围、连接状态和运行日志，
再查看下方的常见问题。

## 聊天模式与助手模式

| 模式 | 适合什么场景 |
| --- | --- |
| 聊天模式 | 人格对话、群聊参与、看图、表情、搜索与主动聊天 |
| 助手模式 | 从微信交办任务，使用已授权的 DSH 工具与技能 |

助手模式需要配置管理员身份，并为目标聊天明确授权。
两种模式分别保留设置与上下文。

配置步骤和使用示例见
[远程助手教程](docs/ASSISTANT_REMOTE.md)。

## 使用教程

| 我想做什么 | 教程 |
| --- | --- |
| 熟悉界面、为聊天选择人格与模式 | [界面与聊天设置](docs/UI_LAYOUT.md) |
| 切换主题预设与主看板布局 | [主题预设](docs/THEME_PRESETS.md) |
| 更换或切换匹配微信程序 | [微信程序与版本选择](docs/WECHAT_CLIENT_SELECTION.md) |
| 通过微信交办任务 | [远程助手](docs/ASSISTANT_REMOTE.md) |
| 为指定聊天分配工具与技能 | [能力授权](docs/DSH_CHAT_ACCESS.md) |
| 接收附件、回传任务成果 | [文件收发](docs/FILE_TRANSFER.md) |
| 配置转写、语音合成和音色 | [语音对话](docs/VOICE_OUTPUT.md) |
| 选择 OCR 或 UIA，设置逐字输入、离屏或恢复草稿 | [桌面发送](docs/FOREGROUND_INPUT.md) |
| 添加和管理表情 | [表情管理](docs/STICKER_MANAGER.md) |
| 接入 dsh-meme 图库 | [图库接入](docs/DSH_MEME.md) |
| 安装鱼的记事本 | [记事本插件](docs/FISH_NOTEBOOK.md) |
| 了解群友记忆 | [群友记忆](docs/MEMBER_MEMORY.md) |
| 更换安装位置、迁移数据 | [数据位置与迁移](docs/DATA_STORAGE.md) |


## 语音设置

桌面安装器内置“语音识别 API”和“语音对话 API”，两者默认关闭。在“能力 → 能力目录”选择需要的插件，配置服务并授权聊天。

- 使用**语音转文字**时，在语音识别 API 填写服务地址、密钥和模型，允许插件运行后用内置短句测试，再为目标聊天授权语音读取。[识别配置](docs/VOICE_INPUT.md)
- 使用**语音回复**时，在语音对话 API 配置合成服务，选专用 TTS 或 Realtime 朗读，再试听模型与音色。使用 DSH 回复模式时，由当前聊天模型逐轮选择输出形式。需要转写时，可在插件中选择实时识别或单条识别。同一聊天只授权一个转写插件。[对话、提供商和音色设置](docs/VOICE_OUTPUT.md)

本地转写可使用 Whisper，语音合成可使用 GPT-SoVITS。在连接设置中打开“本地语音服务与模型方案”，保存解释器和模型位置，选择方案并点击“保存并使用”。[配置 Whisper](docs/LOCAL_WHISPER.md) · [配置 GPT-SoVITS](docs/LOCAL_GPT_SOVITS.md)

## 插件安装

### 下载插件包

插件压缩包位于仓库的 [`optional-extensions/packages/`](optional-extensions/packages/) 目录。
下表列出可用的压缩包和对应教程。

| 插件 | 下载 ZIP | 使用说明 |
| --- | --- | --- |
| 语音对话 API | [speech-synthesis-1.8.2.zip](optional-extensions/packages/speech-synthesis-1.8.2.zip) | [语音合成、实时和单条转写](docs/VOICE_OUTPUT.md) |
| 语音识别 API | [speech-recognition-1.7.2.zip](optional-extensions/packages/speech-recognition-1.7.2.zip) | [API 配置与语音转写](docs/VOICE_INPUT.md) |
| 鱼的记事本 | [fish-notebook-1.1.1.zip](optional-extensions/packages/fish-notebook-1.1.1.zip) | [记事本插件说明](docs/FISH_NOTEBOOK.md) |

每个 ZIP 都附有同名的 `.sha256` 校验文件，位于同一目录。安装时直接导入 ZIP，无需解压。

导入插件时，控制台会检查所需的宿主能力。两个语音插件使用 `audio-segments-v1` 读取分段音频，鱼的记事本使用 `diary-question-v1` 处理日记询问。

### 安装步骤

在“能力 → 能力目录”拖入 WeChatAgent API v2 插件 ZIP：

1. 核对插件名称、版本与权限。
2. 安装插件。
3. 配置参数，并选择允许使用的聊天。
4. 启用插件。
5. 带页面的插件在卡片上点击“打开”进入。页面在隔离环境中运行，只能读写本插件设置并调用本插件动作。

安装后默认关闭。更新与卸载的数据保留规则，
以插件说明和界面提示为准。

WeChatAgent 插件与 DSH 插件分别管理，安装包不通用。

插件宿主校验使用 `npm run plugin:check`。源码与安装器构建会检查权限、能力声明和第一方 ZIP 与源码的一致性。

[插件开发规范](docs/PLUGIN_DEVELOPMENT.md)
· [聊天小便签示例](examples/plugins/chat-notes/)
· [鱼的记事本](docs/FISH_NOTEBOOK.md)

## 常见问题

### 自建搜索后端总是超时怎么办？

自建 Search API 或响应较慢的搜索后端，可在“能力 → 联网默认设置 → 搜索次数、缓存与超时”将搜索超时调为 30–60 秒；配置 `wechat.search.timeoutMs` 的单位为毫秒，例如 `45000`。默认仍为 20 秒，已有设置不变。若报 `native_timeout`，还需检查 DSH 与后端自身的时限；外层等待不会延长内部超时。详见 [联网搜索说明](docs/WEB_SEARCH.md)。

### 添加好友后为什么没有回复？

检查服务是否启动、好友是否加入允许范围，
以及微信和 DSH 是否连接正常。

### 群聊为什么有时不回复？

检查本群的唤醒方式和回复频率设置。
自然参与模式下，模型也可能选择沉默。

### DSH 插件启用后为什么仍连接不上？

确认添加的是当前安装位置提供的插件，
并从托盘完整退出、重新打开 DSH。
进一步检查“设置 → 诊断”中的连接结果。

### 更新 DSH 后为什么不回复了？

在“设置 → 诊断”重新准备配置，确认 DSH 已加载当前安装目录里的桥接插件，然后从托盘完整退出并重开 DSH，再启动 WeChatAgent 服务。

### 切换微信程序时提示版本不匹配？

在“设置 → 微信与 DSH”重新选择微信安装目录中的 `Weixin.exe`。如果提示版本不匹配，先核对微信的完整版本号和所安装发行版的支持范围。[微信程序与版本选择](docs/WECHAT_CLIENT_SELECTION.md)

### 关闭窗口后为什么还在运行？

窗口“×”会收起到托盘。
需要停止后台并关闭程序时，请使用“退出应用”。

### 升级会丢失数据吗？

升级前先核对发送队列并备份数据目录。「WeChatAgent Desktop」同位置升级沿用其数据。从旧 fork 切换时，使用新的安装根目录和空数据目录完成首次配置。[数据位置与迁移](docs/DATA_STORAGE.md)

### 为什么看不到表情包

先确认电脑微信是否已有该表情的完整副本。本机缺失且下载开关关闭时，日志会显示 `STICKER_CDN_DISABLED`。如允许从腾讯补充下载，在“表情包 → 来源与搜索 → 缺失资源下载与旧版兼容”开启“允许从腾讯下载缺失的表情包”，保存后重试；已有本机副本仍可直接读取。

## 升级与更新

升级前：

1. 停止助手服务。
2. 完整退出 WeChatAgent、DSH 和匹配微信。
3. 核对当前数据位置。

安装新版后，按发布说明准备连接配置并重新打开 DSH。

[查看发布说明](RELEASE_NOTES.md)
· [下载新版](https://github.com/sourcepro5/WeChatAgent/releases)

## 开发与构建

开发前请了解目录职责、外部组件和构建前置条件。

- [项目目录](docs/PROJECT_LAYOUT.md)
- [构建安装器](docs/INSTALLER_RELEASE.md#构建安装器)
- [插件开发](docs/PLUGIN_DEVELOPMENT.md)


## 数据与隐私

WeChatAgent 的配置、缓存和运行数据保存在本机。
DSH 独立管理自己的会话与附件。

启用模型后，相关聊天内容和附件会交给所选模型服务处理。
分享日志、截图或配置前，请移除账号、凭据和聊天隐私信息。

## 许可证与致谢

本项目包含不同来源和许可的组件，
具体范围见 [LICENSES.md](LICENSES.md)。

感谢相关上游项目及贡献者。

欢迎通过 [Issues](https://github.com/sourcepro5/WeChatAgent/issues)
反馈问题。提交时请附上版本、复现步骤和脱敏日志。

<!-- 325328799 -->
