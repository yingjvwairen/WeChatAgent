# 桌面版安装与构建

WeChatAgent 运行在 Windows 10/11 x64。桌面发送支持微信 4.2.0.53。请分别安装微信和 DSH。WeChatAgent 安装器自带 Node.js、消息读取与 OCR 运行环境、OCR 模型、桌面组件和语音插件。

## 安装与首次启动

本开发分支使用微信 4.2.0.53。按下方步骤从当前提交构建 Windows x64 安装器，所选根目录下的 `app/` 存放程序，`data/` 存放配置和运行数据。

桌面发送版在 Windows 中登记为「WeChatAgent Desktop」，使用独立的安装标识、快捷方式和数据登记。从旧 fork 切换时请选一个新根目录。安装完成后，在启动新版机器人前停止旧版服务。

打开控制台，在连接设置中选择本机 `Weixin.exe` 和 DSH，验证读取账号，再添加允许自动回复的好友或群聊。发送方式和快捷键见[桌面发送设置](FOREGROUND_INPUT.md)。

本地语音服务可随桌面启动预热。退出桌面或机器人会释放各自的服务租约，其他仍在运行的使用者继续保留模型。停止机器人先请求发送器结束或取消录音并清理焦点；失败时保留进程与所有权记录，不强杀录音进程。

## 源码准备

```powershell
npm ci
npm run setup
npm run console
```

根目录的 `npm ci` 安装锁定版 Electron 包，首次启动桌面控制台或构建安装器时下载对应的桌面运行文件。也可用 `npm exec install-electron` 提前准备。`setup.ps1` 安装 DSH 桥接插件和 Reader 所需的依赖。未指定桌面解释器时建立 `state/input/venv`，并建立单独的 OCR venv，运行 `desktop-sender/build-native.ps1 -SelfTest` 与无障碍兼容组件自测，并准备校验固定摘要的 OCR 模型。已有模型时复用。`-SkipOcrModelDownload` 仅用于离线环境已另行准备模型的情况。

首次数据库配置沿用现有 Reader 辅助组件。`prepare-reader-key.mjs` 从读取组件记录的固定上游 commit 获取并核对完整 SHA-256，也可用 `--source` 导入已有的相同文件；准备过程不执行组件，二进制不进入公开源码。安装器将其作为独立运行时资源并再次核对摘要。

安装版的“检查模拟输入依赖”会核对已部署的解释器、OCR 模型摘要与原生组件文件。

GPT-SoVITS 和 Whisper 模型环境由用户配置，未打入基础安装器。预热或加载模型不扩大插件的聊天授权。

## 构建安装器

```powershell
npm run installer:build
```

构建按 `scripts/installer-runtime-lock.json` 下载并校验 Windows x64 Node.js、嵌入式 Python 及完整 wheel 依赖。在空目录内分别展开 Reader 和 OCR 环境，`DEPENDENCIES.json` 记录各自锁定的依赖和摘要。可先运行 `npm run installer:runtime` 预取经校验的依赖。

正式源码包、副机导出和安装器都从 Git 的 `HEAD` 创建快照。源码检查和原生组件编译在快照中运行，DSH 桥接插件依赖按快照中的 npm 锁文件安装。未提交的源码变更要先提交才会进入发行包。`deployment.json` 的 `sourceCommit` 和源码报告的 `commit` 可用于核对构建来源。`deployment.json` 标记 `desktopRuntime:true`、`wechatVersion:4.2.0.53`、`bundledWechatVersions:[]`。

可用 `node scripts/build-installer.mjs --stage-only` 只准备和校验安装目录，不调用 NSIS。源码 ZIP 和独立桌面 EXE 的构建分别是 `npm run source:build`、`npm run desktop:build`。桌面发送版使用 `0.4.6`，安装器名为 `WeChatAgent-Setup-0.4.6-x64.exe`。构建过程会解包和压缩运行时。如果系统临时盘空间不足，可在构建终端将 `TEMP` 和 `TMP` 指向有足够空间的现有目录。

在同一提交上构建安装器和源码包后，运行 `npm run release:verify`。核验使用该提交的依赖锁和插件清单，按源码快照比对暂存目录和展开目录里的桌面程序代码及启动配置，再解开最终安装器逐文件比对 x64 应用。生成的 `release/installer/SHA256SUMS.txt` 与 `VERIFICATION.json` 记录产物摘要和来源提交，可用于发布前核对。

## 开发检查

在测试用 Python 环境安装 `scripts/test-requirements.txt` 中的依赖，用 `WECHATAGENT_TEST_PYTHON` 指向该解释器，再运行 `npm test`。`npm run check` 会额外检查 JSDoc 类型、格式和 Windows 原生组件。审查提交系列时可用 `npm run check -- --base <目标提交>` 指定对比基线。

运行 `npm run check:integration` 或 `npm run test:integration` 时，将 `WECHATAGENT_DSH_SDK_ROOT` 指向包含 `node_modules` 的 SDK 目录，将 `WECHATAGENT_TEST_DSH` 指向本机 DSH 可执行文件的绝对路径。检查会用真实 DSH 和离线模型验证会话与工具授权。Windows 原生组件的编译和自检也可单独运行 `npm run desktop:native`。

Windows PR 检查安装固定版本的 DSH SDK，运行工具执行器在会话间重新绑定的用例。真实 DSH 桌面运行时由集成检查覆盖。
