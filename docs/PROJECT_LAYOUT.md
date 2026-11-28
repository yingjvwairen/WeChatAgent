# 项目目录与运行数据

Reader 从当前账号读取消息，微信适配器通过本机 WebSocket 将授权聊天的事件交给 Social Bridge 和 DSH。协议名为 `wechatagent-ws-v1`。账号、好友、群和群成员的 ID 均为原始微信字符串，消息与投递回执各有自己的编号。回复进入 `wechat-ui` 发送队列，由 OCR 或 UIA 定位微信窗口中的目标。

| 目录 | 内容 |
| --- | --- |
| `scripts/desktop-sender/` | 共用发送队列、原生桌面组件、OCR/UIA 布局、焦点与录音生命周期、恢复记录 |
| `scripts/wechat-onebot.mjs` | 平台适配、聊天授权、Reader 回执与媒体接线 |
| `scripts/reader-api.py` 和媒体模块 | NT 数据库消息、历史与附件解析 |
| `components/weflow-cli/` | 有来源记录的 NT 读取组件；首次配置的本机取密钥依赖由运行时另行准备 |
| `components/qq-bridge/` | Social Bridge、人格、消息缓冲与工具协作 |
| `packages/dsh-social-bridge-plugin/` | 外部 DSH 的会话、模型、工具和权限接入 |
| `packages/plugin-api/`、`packages/extension-runtime/` | 插件宿主契约、安装、运行和配置校验 |
| `optional-extensions/` | 语音、记事本等插件源码及 `packages/` 下可导入的 ZIP |
| `apps/console-desktop/`、`public/console/` | 桌面外壳、配置界面、主题与数据位置 |
| `roles/`、`config/*.example.json` | 人格预设与不含账号的配置模板 |
| `scripts/local-speech-*`、`scripts/local-model-*` | 本地语音进程生命周期、模型预热和具名方案 |
| `docs/` | 安装与使用指南、接口说明和版本记录 |

`state/`、本机 `config/wechatagent.json`、凭据、模型、用户插件和聊天数据均为私有运行数据，不进入公开源码。公开文件清单由 `public-source-check.mjs --files` 校验；不要把整个工作目录复制进安装器。

`state/installer-stage/` 是安装暂存目录，包含 app、project、runtime 和 desktop-native；`release/` 是构建产物。修改源码后需要重新构建才能更新 EXE。

源码开发环境把 OCR 放在 `state/ocr/venv`。安装版使用版本化的独立 Reader/桌面 Python 和 OCR Python，由 `config/distribution.json` 指向。GPT-SoVITS/Whisper 模型环境由用户配置，不跟随基础安装包复制。

清理构建缓存前先停止使用它的进程。配置、模型和未确认投递的记录需要保留。移动工作区时按[数据迁移说明](DATA_STORAGE.md)操作。

## 开发检查

在 Git 工作区中安装根目录和 `packages/dsh-social-bridge-plugin` 的 npm 依赖；测试 Python 安装 `scripts/test-requirements.txt`，并通过 `WECHATAGENT_TEST_PYTHON` 指向其解释器。`npm test` 运行 JavaScript 静态检查及 Python、Node 回归，包含布局、编辑框像素和搜索弹窗的合成图像测试。

提交前运行 `npm run check`：它另检查 JS/Python/C# 格式、Git 空白错误、Windows 原生组件构建及合成自检、公开源码清单。C# 格式工具通过 `CLANG_FORMAT` 指定，Python 使用测试环境中的 Ruff，也可通过 `RUFF` 指定。格式范围自动包含相对 `v0.4.5` 的新增和修改源码及未提交的新文件；调整系列基线时设置 `WECHATAGENT_QUALITY_BASE`。

`npm run check:integration` 还要求 `WECHATAGENT_DSH_SDK_ROOT` 指向包含实际 DSH SDK `node_modules` 的目录。真实 Whisper 回归由 `WECHATAGENT_TEST_WHISPER_MODEL` 指向已准备的模型；NSIS 夹具需要已缓存的构建工具。条件跳过会在测试结果中单独报告。原生合成自检不操作微信；实际收发、显示适配和完整安装部署需另行验收。
